# Marbella 2026 — sito

Pagina singola, autonoma: `index.html` non ha dipendenze esterne (niente CDN, niente font remoti). Funziona anche aperta in locale con doppio click.

## Pubblicare su GitHub Pages

### Via interfaccia web (5 minuti, nessun comando)

1. Vai su [github.com/new](https://github.com/new) e crea una repo, es. `marbella-2026`. Impostala **Public** (con account gratuito Pages funziona solo su repo pubbliche).
2. Nella repo appena creata clicca **Add file → Upload files** e trascina dentro `index.html`, `README.md` e `.nojekyll`.

   ⚠️ `.nojekyll` è un file nascosto: sul Mac premi `Cmd + Shift + .` nel Finder per vederlo.
3. Clicca **Commit changes**.
4. Vai in **Settings → Pages** (menu a sinistra).
5. Sotto *Build and deployment* → *Source* scegli **Deploy from a branch**; come branch seleziona **main** e cartella **/ (root)**. Salva.
6. Aspetta 1-2 minuti e ricarica la pagina: comparirà il link.

Il tuo indirizzo sarà:

```
https://<tuo-username>.github.io/marbella-2026/
```

### Via terminale

```bash
cd marbella-site
git init
git add .
git commit -m "Marbella 2026"
git branch -M main
git remote add origin https://github.com/<tuo-username>/marbella-2026.git
git push -u origin main
```

Poi comunque **Settings → Pages** e imposta il branch `main` / root come al punto 5 sopra.

## Note

- Il primo deploy richiede 1-2 minuti; gli aggiornamenti successivi 30-60 secondi.
- Se cambi il contenuto, modifica direttamente `index.html` (o rigenerami la pagina dal markdown) e ricarica con `Cmd + Shift + R` per bypassare la cache.
- La pagina è responsive, ha il tema scuro automatico e uno stile di stampa dedicato: da browser puoi fare *Stampa → Salva come PDF* e ottenere una versione pulita da allegare.
- Repo pubblica = pagina indicizzabile da Google. Se preferisci tenerla riservata, usa un nome repo poco intuitivo, oppure valuta un Gist segreto o Netlify Drop.
