# Schiavo Marbella — bot Telegram

Bot che risponde nel gruppo alle domande sul piano di viaggio. Legge
`index.html` direttamente da GitHub, quindi **quando aggiorni il piano il bot
si aggiorna da solo** (entro 10 minuti, senza rideploy).

Gira su Cloudflare Workers via webhook (nessun server sempre acceso) e usa
l'**API Gemini di Google sul tier gratuito**: per un gruppo di 4 persone che fa
qualche domanda al giorno il costo è **zero**, non "quasi zero".

---

## Setup dal telefono

Tutti i passi si fanno dal browser. Servono circa 15 minuti.
Fai i passi **in ordine**: il 4 non funziona se non hai fatto il 3.

### 1 · Token del bot (BotFather)

Apri [@BotFather](https://t.me/botfather) e manda `/revoke` → scegli
`@schiavomarbellabot`. Ti dà un **token nuovo** e invalida quello vecchio.

Fallo davvero: il token precedente è passato in una chat, quindi va considerato
bruciato. Copia il nuovo token e tienilo per il passo 4 — non incollarlo da
nessun'altra parte.

### 2 · Cloudflare

1. Registrati su [dash.cloudflare.com](https://dash.cloudflare.com) (gratis).
2. **Account ID**: vai su *Workers & Pages*. L'ID è nella barra laterale
   destra, oppure è la stringa nell'URL subito dopo `dash.cloudflare.com/`.
   Copialo.
3. **Sottodominio workers.dev — solo se è il primo Worker che pubblichi su
   questo account.** Su un account nuovo, Cloudflare normalmente te lo chiede
   al primo deploy con un prompt interattivo — cosa che GitHub Actions, non
   essendo interattivo, non può gestire, e il deploy fallirebbe con un
   errore secco ("This command cannot be run in a non-interactive context").
   Registralo prima a mano: nella dashboard *Workers & Pages*, se non hai
   ancora un Worker, ti viene proposto di scegliere un sottodominio (es.
   `tuonome.workers.dev`) — confermalo. Se non lo vedi proporre, cerca
   *Workers & Pages → Settings* nella dashboard.
4. **API token**: [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
   → *Create Token* → usa il template **Edit Cloudflare Workers** → *Continue*
   → *Create Token*. Copialo: **te lo mostra una volta sola.**

### 3 · Chiave API Gemini

Se ne hai già generata una su [Google AI Studio](https://aistudio.google.com)
(*Get API key* → *Create API key*), va benissimo, usa quella. Un dettaglio a
cui prestare attenzione: se la chiave è legata a un progetto Google Cloud con
la fatturazione attiva, le richieste passano sul tier a pagamento anche se il
costo per questo bot resta comunque trascurabile.

Per essere sicuri di restare a **costo zero garantito**, la strada più
semplice è crearne una nuova dedicata: su AI Studio, *Create API key* → **New
Project** (non uno che ha già la fatturazione collegata). Le chiavi su un
progetto senza fatturazione restano sul tier gratuito finché non la attivi tu
esplicitamente.

Il limite giornaliero del tier gratuito cambia periodicamente e Google non lo
pubblica più a numero fisso — dopo aver creato la chiave lo vedi in tempo
reale su [aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit).
Per un gruppo di 4 persone con poche domande al giorno è comunque ampiamente
sufficiente in ogni scenario realistico.

### 4 · Secret su GitHub

Sul telefono, nella repo: **Settings → Secrets and variables → Actions →
New repository secret**. Ne servono cinque, uno alla volta:

| Nome | Valore |
|---|---|
| `CLOUDFLARE_API_TOKEN` | il token del passo 2.4 |
| `CLOUDFLARE_ACCOUNT_ID` | l'account ID del passo 2.2 |
| `TELEGRAM_BOT_TOKEN` | il token nuovo del passo 1 |
| `GEMINI_API_KEY` | la chiave del passo 3 |
| `WEBHOOK_SECRET` | una password a caso che inventi tu, 20-40 caratteri, solo lettere e numeri |

`WEBHOOK_SECRET` non devi prenderlo da nessuna parte: te lo inventi. Serve solo
a far sì che il Worker accetti richieste da Telegram e da nessun altro.
**Segnatelo**, ti serve al passo 6.

### 5 · Deploy

Repo → tab **Actions** → *Deploy bot Telegram* → **Run workflow**.

Non serve creare il Worker a mano nella dashboard Cloudflare: questo comando
lo crea da solo (usa il nome `marbella-bot` scritto in `bot/wrangler.toml`),
la prima volta lo crea, le volte dopo lo aggiorna.

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
a tue spese (o, con la chiave gratuita, semplicemente consumare il tuo tier
gratuito). Apri `bot/wrangler.toml` da GitHub (icona matita), metti l'ID del
passo 7 e fai commit:

```toml
ALLOWED_CHAT_IDS = "-1001234567890"
```

Il commit fa ripartire il deploy da solo. Fatto.

### 9 · Memoria della conversazione

Già configurata: `bot/wrangler.toml` punta a un namespace KV di Cloudflare
(gratis a questi volumi) creato apposta per questo bot. Il bot ricorda gli
ultimi **8 scambi per ogni topic**, che scadono dopo 7 giorni. `/dimentica`
azzera la memoria di quel topic.

Se in futuro serve un namespace nuovo (es. altro account Cloudflare): da
terminale, dentro `bot/`, `npx wrangler kv namespace create CHAT_HISTORY`
stampa un blocco `[[kv_namespaces]]` con un nuovo `id` da incollare al posto
di quello attuale in `wrangler.toml`. Commit → il deploy riparte da solo.

Se salti questo passo non si rompe niente: il codice controlla se il binding
c'è e, se manca, lavora come prima.

---

## Uso

Nel gruppo, menzionando il bot:

- `@schiavomarbellabot quanto costa la barca per 4 ore?`
- `@schiavomarbellabot che si fa lunedì?`
- `@schiavomarbellabot quanto ci vuole per Ronda?`

Oppure rispondendo a un suo messaggio, senza rimenzionarlo.

Potete continuare il discorso senza ripetere il contesto:

> — `/chiedi quanto costa il Caminito?`
> — *Il biglietto è 10-18 euro a testa, più 2,50 di navetta…*
> — `/chiedi e come ci arriviamo?`
> — *In auto, un'ora e mezza da Marbella…*

**Da dove prende le risposte**, in quest'ordine:

1. **Il piano di viaggio** (`index.html`), che resta la fonte autorevole su
   date, prezzi verificati e decisioni già prese.
2. **La sua conoscenza generale**, quando la domanda esce dal piano — e in
   quel caso lo dichiara ("nel piano non c'è, ma…").
3. **La ricerca web di Google**, per tutto ciò che cambia nel tempo: meteo,
   orari, disponibilità dei biglietti, eventi, scioperi, traffico. Quando
   cerca davvero, in fondo al messaggio compare `Cercato online: …` con le
   fonti.

Il bot sa anche **che giorno è oggi** e quanto manca alla partenza, quindi
"che si fa domani?" funziona.

Per spegnere la ricerca web, in `wrangler.toml`: `ENABLE_SEARCH = "false"`.

Comandi: `/help`, `/chatid`, `/dimentica`.

---

## Costi

**Zero**, se la chiave del passo 3 è su un progetto senza fatturazione: il
modello di default, `gemini-3.5-flash`, resta sul tier gratuito di Google AI
Studio. Il limite giornaliero esatto lo vedi su
[aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit) dopo
aver generato la chiave — per 4 persone con qualche domanda al giorno per una
settimana non lo avvicinate nemmeno.

Se per qualche motivo il tier gratuito risultasse bloccato (succede, Google
verifica gli account in modo poco prevedibile) o esaurito, il piano B è
immediato: sostituisci il valore del secret `GEMINI_API_KEY` su GitHub con la
tua chiave a pagamento — stesso nome di secret, nessuna modifica al codice. Il
costo su quella, con `gemini-3.5-flash`, resta comunque nell'ordine di
frazioni di centesimo a messaggio.

Cloudflare Workers: gratis a questi volumi.

---

## Note

- **I messaggi del gruppo passano dall'API Gemini di Google** sulla tua
  chiave. I tuoi amici dovrebbero saperlo. Sul tier gratuito, Google può usare
  il contenuto delle richieste per migliorare i propri modelli (non succede
  sul tier a pagamento) — per delle domande su un viaggio è una cosa
  irrilevante, ma è corretto saperlo.
- **Con la ricerca web attiva, le domande escono anche verso Google Search**,
  non solo verso l'API Gemini. Vale la stessa avvertenza del punto sopra.
- Il piano resta la fonte autorevole, ma il bot **non è più limitato a
  quello**: può usare la propria conoscenza e cercare online. Questo vuol dire
  che può anche sbagliare su cose che non stanno nel piano — per le decisioni
  che contano (prenotazioni, prezzi, orari) verificate alla fonte.
- La memoria è **per topic**: due topic diversi dello stesso gruppo hanno
  conversazioni separate. Con la privacy mode attiva il bot legge comunque
  solo i messaggi che lo menzionano o che rispondono a lui, quindi in memoria
  finiscono solo quelli, non tutta la chat del gruppo.
- Cambiare il piano non richiede rideploy — il bot rilegge il file da GitHub.
- Se il bot smette di rispondere, controlla in ordine: il webhook
  (`https://api.telegram.org/botTOKEN/getWebhookInfo` mostra l'ultimo errore),
  poi i log del Worker su Cloudflare (*Workers & Pages → marbella-bot → Logs*).
