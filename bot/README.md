# Schiavo Marbella — bot Telegram

Bot che risponde nel gruppo alle domande sul piano di viaggio. Legge
`index.html` direttamente da GitHub, quindi **quando aggiorni il piano il bot
si aggiorna da solo** (entro 10 minuti, senza rideploy).

Gira su Cloudflare Workers via webhook: nessun server sempre acceso, piano
gratuito più che sufficiente per un gruppo di amici.

---

## Setup dal telefono

Tutti i passi si fanno dal browser. Servono circa 15 minuti.
Fai i passi **in ordine**: il 4 non funziona se non hai fatto il 3.

### 1 · Token del bot (BotFather)

Apri [@BotFather](https://t.me/botfather) e manda `/revoke` → scegli
`@schiavomarbellabot`. Ti dà un **token nuovo** e invalida quello vecchio.

Fallo davvero: il token precedente è passato in una chat, quindi va considerato
bruciato. Copia il nuovo token e tienilo per il passo 3 — non incollarlo da
nessun'altra parte.

### 2 · Cloudflare

1. Registrati su [dash.cloudflare.com](https://dash.cloudflare.com) (gratis).
2. **Account ID**: vai su *Workers & Pages*. L'ID è nella barra laterale
   destra, oppure è la stringa nell'URL subito dopo `dash.cloudflare.com/`.
   Copialo.
3. **API token**: [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
   → *Create Token* → usa il template **Edit Cloudflare Workers** → *Continue*
   → *Create Token*. Copialo: **te lo mostra una volta sola.**

### 3 · Chiave API Anthropic

Vai su [console.anthropic.com](https://console.anthropic.com) → *API Keys* →
crea una chiave. È a consumo e **non è inclusa nell'abbonamento Claude Code**:
paghi tu i messaggi del gruppo. Per 4 persone si parla di pochi centesimi al
mese (vedi *Costi* sotto).

### 4 · Secret su GitHub

Sul telefono, nella repo: **Settings → Secrets and variables → Actions →
New repository secret**. Ne servono cinque, uno alla volta:

| Nome | Valore |
|---|---|
| `CLOUDFLARE_API_TOKEN` | il token del passo 2.3 |
| `CLOUDFLARE_ACCOUNT_ID` | l'account ID del passo 2.2 |
| `TELEGRAM_BOT_TOKEN` | il token nuovo del passo 1 |
| `ANTHROPIC_API_KEY` | la chiave del passo 3 |
| `WEBHOOK_SECRET` | una password a caso che inventi tu, 20-40 caratteri, solo lettere e numeri |

`WEBHOOK_SECRET` non devi prenderlo da nessuna parte: te lo inventi. Serve solo
a far sì che il Worker accetti richieste da Telegram e da nessun altro.
**Segnatelo**, ti serve al passo 6.

### 5 · Deploy

Repo → tab **Actions** → *Deploy bot Telegram* → **Run workflow**.

Al termine, nel log del job, cerca la riga con l'URL pubblicato. Sarà tipo:

```
https://marbella-bot.TUO-SOTTODOMINIO.workers.dev
```

Copialo. Se apri quell'indirizzo nel browser deve rispondere
`Schiavo Marbella is alive.`

### 6 · Collegare Telegram al Worker

Componi questo indirizzo mettendo i tuoi valori al posto delle tre parti in
maiuscolo, e **aprilo nel browser del telefono**:

```
https://api.telegram.org/botTOKEN/setWebhook?url=URL_DEL_WORKER&secret_token=WEBHOOK_SECRET
```

Deve rispondere `{"ok":true,...,"description":"Webhook was set"}`.

### 7 · Aggiungere il bot al gruppo

Aggiungi `@schiavomarbellabot` al gruppo come membro normale.

**Lascia la privacy mode attiva** (è il default): così il bot riceve solo i
messaggi che lo menzionano o che rispondono a un suo messaggio, invece di
leggere tutta la conversazione.

Scrivi `/chatid@schiavomarbellabot` nel gruppo: ti risponde con l'ID.

### 8 · Chiudere il bot al solo tuo gruppo

Finché non fai questo passo, chiunque scopra `@schiavomarbellabot` può usarlo
a tue spese. Apri `bot/wrangler.toml` da GitHub (icona matita), metti l'ID del
passo 7 e fai commit:

```toml
ALLOWED_CHAT_IDS = "-1001234567890"
```

Il commit fa ripartire il deploy da solo. Fatto.

---

## Uso

Nel gruppo, menzionando il bot:

- `@schiavomarbellabot quanto costa la barca per 4 ore?`
- `@schiavomarbellabot che si fa lunedì?`
- `@schiavomarbellabot quanto ci vuole per Ronda?`

Oppure rispondendo a un suo messaggio, senza rimenzionarlo.

Comandi: `/help`, `/chatid`.

---

## Costi

Con `claude-sonnet-5` (il default), un messaggio costa circa **mezzo centesimo**
grazie alla cache del prompt. Un gruppo che fa 200 domande al mese sta sotto
l'euro.

Per dimezzare, cambia `CLAUDE_MODEL` in `bot/wrangler.toml`:

| Modello | Prezzo (input/output per milione di token) | Note |
|---|---|---|
| `claude-haiku-4-5` | $1 / $5 | Il più economico. Il piano è sotto la soglia minima di cache di Haiku, quindi la cache non si attiva |
| `claude-sonnet-5` | $3 / $15 ($2/$10 promo fino al 31/08/2026) | **Default.** Miglior compromesso, la cache funziona |
| `claude-opus-5` | $5 / $25 | Sovradimensionato per rispondere a "a che ora è la barca" |

Cloudflare Workers: gratis a questi volumi.

---

## Note

- **I messaggi del gruppo passano dall'API Anthropic** sulla tua chiave. I tuoi
  amici dovrebbero saperlo.
- Il bot conosce **solo** il contenuto di `index.html`. Non ha memoria: ogni
  domanda parte da zero, tranne il messaggio a cui stai rispondendo.
- Cambiare il piano non richiede rideploy — il bot rilegge il file da GitHub.
- Se il bot smette di rispondere, controlla in ordine: il webhook
  (`https://api.telegram.org/botTOKEN/getWebhookInfo` mostra l'ultimo errore),
  poi i log del Worker su Cloudflare (*Workers & Pages → marbella-bot → Logs*).
