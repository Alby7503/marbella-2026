/**
 * Bot Telegram "Schiavo Marbella" (@schiavomarbellabot).
 *
 * Cloudflare Worker: Telegram chiama questo endpoint via webhook a ogni
 * messaggio che menziona il bot. Il Worker scarica il piano di viaggio
 * (index.html da GitHub Pages), lo converte in testo e lo passa a Gemini
 * come system prompt, poi rimanda la risposta nel gruppo.
 *
 * Usa l'API Gemini (generateContent) sul tier gratuito di Google AI
 * Studio: nessun costo per un gruppo di poche persone. Nessun segreto
 * nel codice: token e chiavi stanno nei secret del Worker.
 */

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
const TELEGRAM_API = "https://api.telegram.org";

const DEFAULT_MODEL = "gemini-3.5-flash";
const PLAN_TTL_MS = 10 * 60 * 1000; // ricarica il piano al massimo ogni 10 min
const TELEGRAM_MAX_CHARS = 4000; // il limite vero è 4096
const GEMINI_TIMEOUT_MS = 25 * 1000; // oltre, meglio un errore che silenzio infinito

// Cache per-isolate: sopravvive tra richieste finché il Worker resta caldo.
let planCache = null;
let planCachedAt = 0;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Schiavo Marbella is alive.", { status: 200 });
    }

    // Telegram rimanda questo header solo se lo abbiamo impostato con
    // setWebhook: è ciò che impedisce a chiunque di far parlare il bot.
    const signature = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!env.WEBHOOK_SECRET || signature !== env.WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }

    // Rispondiamo subito a Telegram e lavoriamo in background: altrimenti
    // Telegram ritenta la consegna e il bot risponde due volte.
    ctx.waitUntil(handleUpdate(update, env));
    return new Response("ok");
  },
};

async function handleUpdate(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg || typeof msg.text !== "string") return;

  const chatId = msg.chat.id;

  if (!isAllowedChat(chatId, env)) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "Questo bot è privato: è configurato solo per il gruppo Marbella 2026.\n" +
        `ID di questa chat: ${chatId}`,
    });
    return;
  }

  const text = stripBotMention(msg.text, env.BOT_USERNAME).trim();

  if (/^\/(start|help)\b/i.test(text) || text === "") {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      reply_to_message_id: msg.message_id,
      text:
        "Ciao, sono lo Schiavo di Marbella. Conosco il piano del viaggio " +
        "(30/07 – 07/08/2026) e rispondo alle vostre domande.\n\n" +
        "Menzionatemi o rispondete a un mio messaggio, per esempio:\n" +
        "• quanto costa la barca senza patente?\n" +
        "• quanto ci vuole per arrivare a Ronda?\n" +
        "• che si fa martedì?\n\n" +
        "Piano completo: " + planUrl(env),
    });
    return;
  }

  if (/^\/chatid\b/i.test(text)) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      reply_to_message_id: msg.message_id,
      text: `ID di questa chat: ${chatId}`,
    });
    return;
  }

  await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });

  let answer;
  try {
    answer = await askGemini(env, {
      question: text,
      quoted: msg.reply_to_message?.text,
      asker: msg.from?.first_name,
    });
  } catch (err) {
    console.error("askGemini failed:", err);
    answer =
      "Non riesco a rispondere in questo momento. Il piano completo è sempre qui: " +
      planUrl(env);
  }

  for (const part of chunkText(answer, TELEGRAM_MAX_CHARS)) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      reply_to_message_id: msg.message_id,
      text: part,
      // Niente parse_mode: Claude scrive in testo semplice e così un
      // asterisco o un underscore non fanno fallire l'invio.
      link_preview_options: { is_disabled: true },
    });
  }
}

/* ------------------------------------------------------------------ Gemini */

async function askGemini(env, { question, quoted, asker }) {
  const plan = await getPlanText(env);

  const system = `Sei l'assistente del gruppo che sta organizzando un viaggio a Marbella dal 30 luglio al 7 agosto 2026: 4 persone, Hapimag Resort fronte mare, volo su Malaga (AGP), conducenti di 22-23 anni.

Rispondi in italiano. Siete su Telegram, quindi sii breve e concreto: due o tre frasi, oppure un elenco corto. Niente muri di testo.

Scrivi in testo semplice: niente Markdown, niente asterischi per il grassetto, niente tabelle. Se devi elencare, usa trattini.

Basati solo sul piano di viaggio qui sotto. Se una cosa non c'è nel piano, dillo invece di inventarla. I prezzi nel piano sono stime da verificare al momento della prenotazione, non quotazioni definitive: se citi una cifra, chiarisci che è indicativa.

=== PIANO DI VIAGGIO ===
${plan}
=== FINE PIANO ===`;

  let userContent = "";
  if (quoted) userContent += `Messaggio a cui si riferisce la domanda:\n"${quoted}"\n\n`;
  if (asker) userContent += `${asker} chiede: `;
  userContent += question;

  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `${GEMINI_API}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  // Senza timeout, una risposta lenta o appesa di Gemini (più probabile sul
  // tier gratuito) lascia l'utente senza risposta all'infinito invece di
  // arrivare al fallback qui sotto.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: { text: system } },
        contents: [{ role: "user", parts: [{ text: userContent }] }],
        generationConfig: { maxOutputTokens: 400 },
      }),
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`gemini timeout dopo ${GEMINI_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`gemini ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();

  // La richiesta può essere bloccata prima ancora di generare qualcosa
  // (es. contenuto sensibile): in quel caso non c'è nessun candidate.
  if (data.promptFeedback?.blockReason) {
    return "Non me la sento di rispondere a questa domanda.";
  }

  const candidate = data.candidates?.[0];
  if (!candidate) {
    return "Non ho trovato una risposta nel piano.";
  }

  const blockedReasons = ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT"];
  if (blockedReasons.includes(candidate.finishReason)) {
    return "Non me la sento di rispondere a questa domanda.";
  }

  const answer = (candidate.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();

  return answer || "Non ho trovato una risposta nel piano.";
}

/* -------------------------------------------------------------------- Piano */

function planUrl(env) {
  return (
    env.PLAN_URL ||
    "https://raw.githubusercontent.com/alby7503/marbella-2026/main/index.html"
  );
}

async function getPlanText(env) {
  const now = Date.now();
  if (planCache && now - planCachedAt < PLAN_TTL_MS) return planCache;

  const res = await fetch(planUrl(env), { cf: { cacheTtl: 600 } });
  if (!res.ok) {
    if (planCache) return planCache; // meglio un piano vecchio che nessun piano
    throw new Error(`plan fetch ${res.status}`);
  }

  planCache = htmlToText(await res.text());
  planCachedAt = now;
  return planCache;
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", middot: "·", hellip: "…", euro: "€", deg: "°",
  laquo: "«", raquo: "»", aacute: "á", eacute: "é", iacute: "í",
  oacute: "ó", uacute: "ú", agrave: "à", egrave: "è", igrave: "ì",
  ograve: "ò", ugrave: "ù", ntilde: "ñ", ccedil: "ç", uuml: "ü",
};

function decodeEntities(input) {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] !== "#") return NAMED_ENTITIES[body] ?? match;
    const codePoint =
      body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
  });
}

function htmlToText(html) {
  const stripped = html
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote|ul|ol|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, "");

  return decodeEntities(stripped)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    // Le celle di una tabella finiscono ognuna su una riga: ricompattale in
    // una riga sola. Le righe restano separate da una riga vuota.
    .replace(/\|\n(?=[^\n])/g, "| ")
    .replace(/ *\|$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ----------------------------------------------------------------- Telegram */

async function tg(env, method, payload) {
  const res = await fetch(
    `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) {
    console.error(`telegram ${method} ${res.status}: ${await res.text()}`);
  }
  return res;
}

function isAllowedChat(chatId, env) {
  const raw = (env.ALLOWED_CHAT_IDS || "").trim();
  if (raw === "") return true; // non configurato: apri, ma vedi il README
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(chatId));
}

function stripBotMention(text, username) {
  let out = text;
  if (username) {
    out = out.replaceAll(new RegExp(`@${escapeRegex(username)}\\b`, "gi"), " ");
  }
  // "/comando@nomebot" -> "/comando"
  return out.replace(/^\s*(\/[a-z_]+)@\S+/i, "$1");
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function chunkText(text, size) {
  if (text.length <= size) return [text];

  const parts = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = rest.lastIndexOf(" ", size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
