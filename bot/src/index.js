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
// Con la ricerca web attiva Gemini fa un giro in più prima di rispondere:
// 20s erano tarati su un modello che rispondeva a memoria e stavano stretti.
const GEMINI_TIMEOUT_MS = 45 * 1000;
const PLAN_TIMEOUT_MS = 8 * 1000; // il download del piano deve essere rapido

// Memoria della conversazione (richiede il binding KV CHAT_HISTORY).
const HISTORY_MAX_MESSAGES = 16; // 8 scambi domanda/risposta
const HISTORY_TTL_S = 7 * 24 * 60 * 60; // una settimana: il viaggio dura 9 giorni
const HISTORY_MAX_CHARS = 1500; // per messaggio salvato, per non gonfiare la KV

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
    ctx.waitUntil(
      handleUpdate(update, env).catch((err) => {
        // Rete di sicurezza: senza questo, un'eccezione imprevista in un
        // punto non coperto da un try/catch specifico sparisce nel nulla
        // (nessuna riga di log, nessun messaggio all'utente).
        console.error("handleUpdate ha lanciato un'eccezione non gestita:", err);
      })
    );
    return new Response("ok");
  },
};

async function handleUpdate(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg || typeof msg.text !== "string") {
    console.log("update ignorato: non è un messaggio di testo", JSON.stringify(update).slice(0, 300));
    return;
  }

  const chatId = msg.chat.id;
  const threadId = topicThreadId(msg);
  console.log(
    `update ricevuto da chat ${chatId}` +
      (threadId ? ` (topic ${threadId})` : " (nessun topic)") +
      `: "${msg.text.slice(0, 200)}"`
  );

  if (!isAllowedChat(chatId, env)) {
    console.log(`chat ${chatId} non in ALLOWED_CHAT_IDS ("${env.ALLOWED_CHAT_IDS}") — mando il rifiuto`);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      text:
        "Questo bot è privato: è configurato solo per il gruppo Marbella 2026.\n" +
        `ID di questa chat: ${chatId}`,
    });
    return;
  }

  const text = stripBotMention(msg.text, env.BOT_USERNAME).trim();
  console.log(`testo dopo aver tolto la menzione: "${text}"`);

  if (/^\/(start|help)\b/i.test(text) || text === "") {
    console.log("ramo /start /help (o testo vuoto dopo la menzione)");
    await tg(env, "sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      reply_to_message_id: msg.message_id,
      text:
        "Ciao, sono lo Schiavo di Marbella. Conosco il piano del viaggio " +
        "(30/07 – 07/08/2026), so che giorno è oggi, e se serve cerco su " +
        "internet le cose che cambiano: meteo, orari, disponibilità, eventi.\n\n" +
        "Il modo più affidabile per chiedermi qualcosa nel gruppo:\n" +
        "/chiedi quanto costa la barca per 4 ore?\n\n" +
        "In alternativa potete rispondere a un mio messaggio scrivendo solo " +
        "la domanda. (Le semplici menzioni con la @ a volte Telegram non me " +
        "le consegna nei gruppi con i topic.)\n\n" +
        "Mi ricordo gli ultimi messaggi, quindi potete continuare il discorso " +
        "senza ripetere il contesto:\n" +
        "• /chiedi quanto costa il Caminito?\n" +
        "• e come ci arriviamo?\n\n" +
        "Altri comandi:\n" +
        "• /dimentica — cancella la memoria della conversazione\n" +
        "• /chatid — mostra l'ID di questa chat\n\n" +
        "Piano completo: " + planUrl(env),
    });
    return;
  }

  if (/^\/(dimentica|reset)\b/i.test(text)) {
    console.log("ramo /dimentica");
    const done = await clearHistory(env, chatId, threadId);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      reply_to_message_id: msg.message_id,
      text: done
        ? "Fatto, ho dimenticato la conversazione. Il piano di viaggio lo so ancora."
        : "Non ho una memoria da cancellare: lo storage della cronologia non è configurato.",
    });
    return;
  }

  if (/^\/chatid\b/i.test(text)) {
    console.log("ramo /chatid");
    await tg(env, "sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      reply_to_message_id: msg.message_id,
      text:
        `ID di questa chat: ${chatId}` +
        (threadId ? `\nID di questo topic: ${threadId}` : ""),
    });
    return;
  }

  // In privacy mode Telegram non consegna in modo affidabile le @menzioni
  // nei supergruppi con i topic (i comandi e le risposte al bot sì). /chiedi
  // è quindi la strada che funziona sempre per fare una domanda in gruppo.
  const askMatch = text.match(/^\/(chiedi|ask)\b\s*([\s\S]*)$/i);
  const question = askMatch ? askMatch[2].trim() : text;

  if (askMatch && !question) {
    console.log("ramo /chiedi senza domanda");
    await tg(env, "sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      reply_to_message_id: msg.message_id,
      text: "Scrivi la domanda dopo il comando, per esempio:\n/chiedi quanto costa la barca per 4 ore?",
    });
    return;
  }

  console.log(`ramo domanda vera (${askMatch ? "/chiedi" : "menzione o reply"}): chiamo Gemini`);
  await tg(env, "sendChatAction", {
    chat_id: chatId,
    message_thread_id: threadId,
    action: "typing",
  });

  const history = await loadHistory(env, chatId, threadId);
  const replied = msg.reply_to_message;
  const asker = msg.from?.first_name;

  let answer;
  let outgoing;
  let ok = true;
  try {
    const result = await askGemini(env, {
      question,
      quoted: replied?.text,
      // Sapere se il messaggio citato è suo cambia il senso della domanda:
      // "e quello quanto costa?" su una propria risposta è un seguito, sulla
      // frase di un amico è un'altra cosa.
      quotedFromBot: Boolean(replied?.from?.is_bot),
      asker,
      history,
    });
    answer = result.text;
    outgoing = result.sources.length
      ? `${answer}\n\nCercato online: ${result.sources.join(", ")}`
      : answer;
    console.log(`Gemini ha risposto (${answer.length} caratteri)`);
  } catch (err) {
    console.error("askGemini failed:", err);
    ok = false;
    outgoing =
      "Non riesco a rispondere in questo momento. Il piano completo è sempre qui: " +
      planUrl(env);
  }

  // Solo gli scambi riusciti entrano in memoria: salvare un errore di rete
  // significherebbe trascinarselo dietro come se fosse una risposta vera.
  if (ok) {
    history.push({ role: "user", text: asker ? `${asker}: ${question}` : question });
    history.push({ role: "model", text: answer });
    await saveHistory(env, chatId, threadId, history);
  }

  for (const part of chunkText(outgoing, TELEGRAM_MAX_CHARS)) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      reply_to_message_id: msg.message_id,
      text: part,
      // Niente parse_mode: Claude scrive in testo semplice e così un
      // asterisco o un underscore non fanno fallire l'invio.
      link_preview_options: { is_disabled: true },
    });
  }
  console.log("handleUpdate completato");
}

/* ------------------------------------------------------------------ Gemini */

/** Data di oggi e collocazione rispetto al viaggio, in italiano. */
function todayContext() {
  const now = new Date();
  const oggi = new Intl.DateTimeFormat("it-IT", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
    timeZone: "Europe/Madrid",
  }).format(now);

  const partenza = Date.UTC(2026, 6, 30);
  const ritorno = Date.UTC(2026, 7, 7);
  const day = 24 * 60 * 60 * 1000;
  const oggiUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  let dove;
  if (oggiUTC < partenza) {
    const mancano = Math.round((partenza - oggiUTC) / day);
    dove = `Mancano ${mancano} giorni alla partenza.`;
  } else if (oggiUTC <= ritorno) {
    const giorno = Math.round((oggiUTC - partenza) / day) + 1;
    dove = `Il viaggio è in corso: siete al giorno ${giorno} di 9. Privilegia le risposte utili adesso (cosa fare oggi, orari, meteo, come arrivarci).`;
  } else {
    dove = "Il viaggio è finito.";
  }
  return `Oggi è ${oggi} (fuso orario di Marbella). ${dove}`;
}

function buildSystemPrompt(plan) {
  return `Sei l'assistente del gruppo che sta organizzando un viaggio a Marbella dal 30 luglio al 7 agosto 2026: 4 persone, Hapimag Resort fronte mare, volo su Malaga (AGP), conducenti di 22-23 anni con budget da studenti.

${todayContext()}

Rispondi in italiano. Siete su Telegram, quindi sii breve e concreto: due o tre frasi, oppure un elenco corto. Niente muri di testo.

Scrivi in testo semplice: niente Markdown, niente asterischi per il grassetto, niente tabelle. Se devi elencare, usa trattini.

COME SCEGLIERE LA FONTE, in quest'ordine:
1. Il piano di viaggio qui sotto è la fonte autorevole su tutto ciò che il gruppo ha già deciso, verificato o prenotato: date, alloggio, preventivi confermati, calendario, scelte fatte. Su questi punti non contraddirlo.
2. Se la domanda riguarda qualcosa che il piano non copre, usa la tua conoscenza generale e dillo: "nel piano non c'è, ma...".
3. Se la risposta dipende da informazioni che cambiano nel tempo, CERCA SU INTERNET invece di andare a memoria. Vale per: meteo, orari di apertura, disponibilità e prezzi attuali di biglietti, eventi e concerti, scioperi, traffico, notizie locali, cambi di normativa. La tua conoscenza ha una data di scadenza, la ricerca no.

Quando cerchi online e trovi un dato che contraddice il piano, dillo apertamente invece di scegliere in silenzio: "il piano dice X, ma online adesso risulta Y".

I prezzi nel piano contrassegnati come stime sono indicativi e vanno verificati al momento della prenotazione; quelli contrassegnati come verificati sono stati controllati di persona dal gruppo. Se citi una cifra, chiarisci in quale dei due casi sei.

Hai la memoria degli ultimi messaggi di questa conversazione: usala per capire i riferimenti impliciti ("quello", "e quanto costa?", "allora facciamo martedì") senza far ripetere il contesto.

=== PIANO DI VIAGGIO ===
${plan}
=== FINE PIANO ===`;
}

/**
 * Costruisce i "contents" per Gemini: la cronologia della chat seguita dalla
 * domanda attuale. Gemini vuole ruoli alternati, ma in un gruppo possono
 * parlare più persone di fila: i turni utente consecutivi vengono fusi.
 */
function buildContents({ history, question, quoted, quotedFromBot, asker }) {
  const turns = [];
  for (const h of history || []) {
    turns.push({ role: h.role === "model" ? "model" : "user", text: h.text });
  }

  let now = "";
  if (quoted) {
    now += quotedFromBot
      ? `[Sta rispondendo a un tuo messaggio precedente:]\n"${quoted}"\n\n`
      : `[Sta rispondendo a questo messaggio di un altro membro del gruppo:]\n"${quoted}"\n\n`;
  }
  now += asker ? `${asker} chiede: ${question}` : question;
  turns.push({ role: "user", text: now });

  const merged = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.text += "\n\n" + t.text;
    else merged.push({ ...t });
  }
  return merged.map((t) => ({ role: t.role, parts: [{ text: t.text }] }));
}

/** Una chiamata a generateContent. `withSearch` aggiunge il tool di ricerca. */
async function callGemini(env, { system, contents, withSearch }) {
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `${GEMINI_API}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const body = {
    systemInstruction: { parts: { text: system } },
    contents,
    generationConfig: {
      // I token di ragionamento vengono contati dentro maxOutputTokens:
      // con un tetto basso il ragionamento se li mangia quasi tutti e la
      // risposta esce troncata a metà parola. Tetto ampio + ragionamento
      // al minimo (a queste domande non serve) risolve entrambe le cose.
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingLevel: "minimal" },
    },
  };
  if (withSearch) body.tools = [{ google_search: {} }];

  console.log(`gemini: chiamo ${model}${withSearch ? " con ricerca web" : ""}`);
  return fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    GEMINI_TIMEOUT_MS,
    "gemini"
  );
}

async function askGemini(env, { question, quoted, quotedFromBot, asker, history }) {
  const plan = await getPlanText(env);
  const system = buildSystemPrompt(plan);
  const contents = buildContents({ history, question, quoted, quotedFromBot, asker });

  const wantSearch = env.ENABLE_SEARCH !== "false";
  let res = await callGemini(env, { system, contents, withSearch: wantSearch });

  // Se il modello configurato non accetta il tool di ricerca, l'API risponde
  // 400 e senza questo fallback il bot smetterebbe di funzionare del tutto.
  // Meglio una risposta senza internet che nessuna risposta.
  if (!res.ok && wantSearch && res.status === 400) {
    const detail = await res.text();
    console.error(`gemini: ricerca web rifiutata (400), riprovo senza. Dettaglio: ${detail.slice(0, 500)}`);
    res = await callGemini(env, { system, contents, withSearch: false });
  }

  if (!res.ok) {
    throw new Error(`gemini ${res.status}: ${await res.text()}`);
  }
  console.log("gemini: risposta HTTP ricevuta");

  const data = await res.json();

  // La richiesta può essere bloccata prima ancora di generare qualcosa
  // (es. contenuto sensibile): in quel caso non c'è nessun candidate.
  if (data.promptFeedback?.blockReason) {
    return { text: "Non me la sento di rispondere a questa domanda.", sources: [] };
  }

  const candidate = data.candidates?.[0];
  if (!candidate) {
    return { text: "Non ho trovato una risposta nel piano.", sources: [] };
  }

  const u = data.usageMetadata || {};
  console.log(
    `gemini: finishReason=${candidate.finishReason} ` +
      `token risposta=${u.candidatesTokenCount ?? "?"} ` +
      `ragionamento=${u.thoughtsTokenCount ?? 0}`
  );

  const blockedReasons = ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT"];
  if (blockedReasons.includes(candidate.finishReason)) {
    // RECITATION scatta spesso proprio con la ricerca web attiva, quando la
    // risposta cita troppo da vicino il testo trovato online: prima capitava
    // raramente, ora che quasi ogni domanda passa dal tool è diventato comune.
    console.error(`gemini: risposta bloccata (finishReason=${candidate.finishReason})`);
    return { text: "Non me la sento di rispondere a questa domanda.", sources: [] };
  }

  let answer = (candidate.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();

  if (!answer) {
    return { text: "Non sono riuscito a mettere insieme una risposta. Riprova a chiedermelo in altro modo.", sources: [] };
  }

  // Se il tetto di token è stato raggiunto la frase resta tronca a metà:
  // meglio dirlo che lasciar credere che la risposta sia completa.
  if (candidate.finishReason === "MAX_TOKENS") {
    console.error("gemini: risposta troncata (MAX_TOKENS)");
    answer += "\n\n[…risposta troncata. Chiedimi il dettaglio che ti serve.]";
  }

  // Le fonti tornano separate dal testo: vanno mostrate nel messaggio ma NON
  // salvate in memoria. Se il modello si rivedesse davanti "Cercato online:"
  // nei propri turni passati finirebbe per imitare la formula anche quando
  // non ha cercato niente, cioè per attribuirsi fonti inventate.
  const sources = groundingSources(candidate);
  if (sources.length) console.log(`gemini: risposta con ricerca web (${sources.length} fonti)`);

  return { text: answer, sources };
}

/** Titoli delle fonti usate dalla ricerca web, senza duplicati, al massimo 3. */
function groundingSources(candidate) {
  const chunks = candidate.groundingMetadata?.groundingChunks || [];
  const seen = [];
  for (const c of chunks) {
    const title = (c.web?.title || c.web?.domain || "").trim();
    if (title && !seen.includes(title)) seen.push(title);
    if (seen.length === 3) break;
  }
  return seen;
}

/* ------------------------------------------------------------------ Memoria */

/**
 * Cronologia della conversazione, per topic.
 *
 * Telegram consegna al massimo UN livello di reply (reply_to_message), quindi
 * senza uno storage esterno il bot riparte da zero a ogni domanda. La KV dà
 * una memoria vera che sopravvive al riciclo degli isolate del Worker.
 *
 * Se il binding CHAT_HISTORY non è configurato tutto continua a funzionare,
 * solo senza memoria: il bot usa il messaggio citato e basta. Così il deploy
 * non si rompe finché non si crea il namespace (vedi README).
 */
function historyKey(chatId, threadId) {
  return `hist:${chatId}:${threadId || 0}`;
}

async function loadHistory(env, chatId, threadId) {
  if (!env.CHAT_HISTORY) return [];
  try {
    const raw = await env.CHAT_HISTORY.get(historyKey(chatId, threadId), { type: "json" });
    if (!Array.isArray(raw)) return [];
    console.log(`memoria: caricati ${raw.length} messaggi`);
    return raw;
  } catch (err) {
    console.error("memoria: lettura fallita, proseguo senza:", err);
    return [];
  }
}

async function saveHistory(env, chatId, threadId, history) {
  if (!env.CHAT_HISTORY) return;
  try {
    const trimmed = history.slice(-HISTORY_MAX_MESSAGES).map((h) => ({
      role: h.role,
      text: h.text.slice(0, HISTORY_MAX_CHARS),
    }));
    await env.CHAT_HISTORY.put(historyKey(chatId, threadId), JSON.stringify(trimmed), {
      expirationTtl: HISTORY_TTL_S,
    });
    console.log(`memoria: salvati ${trimmed.length} messaggi`);
  } catch (err) {
    // Una scrittura fallita non deve far perdere la risposta già pronta.
    console.error("memoria: scrittura fallita:", err);
  }
}

async function clearHistory(env, chatId, threadId) {
  if (!env.CHAT_HISTORY) return false;
  try {
    await env.CHAT_HISTORY.delete(historyKey(chatId, threadId));
    return true;
  } catch (err) {
    console.error("memoria: cancellazione fallita:", err);
    return false;
  }
}

/* --------------------------------------------------------------------- Rete */

/**
 * fetch con timeout. Senza, una richiesta che resta appesa non solleva mai
 * un'eccezione: il lavoro in background muore in silenzio quando Cloudflare
 * lo interrompe, senza messaggio all'utente e senza una riga di log.
 */
async function fetchWithTimeout(url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`${label}: timeout dopo ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  if (planCache && now - planCachedAt < PLAN_TTL_MS) {
    console.log("piano: uso la copia in cache");
    return planCache;
  }

  console.log("piano: scarico da", planUrl(env));
  const res = await fetchWithTimeout(
    planUrl(env),
    { cf: { cacheTtl: 600 } },
    PLAN_TIMEOUT_MS,
    "plan fetch"
  );
  if (!res.ok) {
    if (planCache) return planCache; // meglio un piano vecchio che nessun piano
    throw new Error(`plan fetch ${res.status}`);
  }

  const html = await res.text();
  console.log(`piano: scaricato (${html.length} caratteri), converto in testo`);
  planCache = htmlToText(html);
  console.log(`piano: pronto (${planCache.length} caratteri di testo)`);
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
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error(`telegram ${method}: TELEGRAM_BOT_TOKEN mancante nell'ambiente`);
    return new Response(null, { status: 401 });
  }

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
  } else {
    console.log(`telegram ${method}: ok (chat ${payload.chat_id ?? "?"})`);
  }
  return res;
}

/**
 * Id del topic a cui rispondere in un supergruppo con i forum attivi.
 *
 * In un forum tutti i topic condividono lo stesso chat.id: senza rimandare
 * indietro message_thread_id la risposta finisce nel topic "General" invece
 * che dove è stata fatta la domanda — e chi guarda il proprio topic non vede
 * comparire nulla.
 *
 * Due casi in cui NON va passato:
 * - messaggi che non appartengono a un topic (is_topic_message assente):
 *   in un gruppo normale message_thread_id può comparire per i thread di
 *   risposta, ma non è un topic;
 * - il topic "General" (id 1): Telegram rifiuta l'invio se glielo passi,
 *   va trattato come un supergruppo normale.
 */
function topicThreadId(msg) {
  if (!msg.is_topic_message) return undefined;
  const id = msg.message_thread_id;
  return typeof id === "number" && id !== 1 ? id : undefined;
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
