# iCorsi Course Assistant (prototipo personale)

Estensione browser **personale** (Manifest V3) che aggiunge una sidebar/chatbox
dentro le pagine di iCorsi (Moodle) e permette di indicizzare e interrogare i
materiali del corso — PDF, risorse `pluginfile.php` / `mod/resource`, pagine
`mod/page` e il testo visibile della pagina — **usando esclusivamente la
sessione già autenticata del browser**.

> ⚠️ Prototipo MVP per uso personale. Non è un'integrazione ufficiale
> dell'università e non va distribuito. Vedi [Limiti, privacy e note
> legali](#limiti-privacy-e-note-legali).

---

## 1. Architettura

```
Pagina iCorsi (browser, sessione autenticata)
│
├── content script (src/content.js) — gira solo su *.icorsi.ch
│     ├── inserisce la sidebar/chatbox (Shadow DOM, CSS isolato)
│     ├── su click "Scansiona questa pagina":
│     │     ├── rileva i link ai materiali (.pdf, pluginfile.php,
│     │     │   mod/resource, mod/page) — solo same-origin
│     │     ├── fetch con credentials: 'include' (i cookie di sessione
│     │     │   vengono usati automaticamente; nessun bypass)
│     │     ├── pdf.js (vendorizzato) estrae il testo pagina per pagina
│     │     ├── DOMParser estrae il testo delle pagine HTML
│     │     └── chunking (~1200 caratteri, overlap 200, taglio su frase)
│     └── invia doc + chunk al background via chrome.runtime.sendMessage
│
└── background service worker (src/background.js)
      ├── IndexedDB (origin dell'estensione): store 'docs' e 'chunks'
      │   (term-frequency precalcolata + embedding per chunk, se disponibile)
      ├── ricerca IBRIDA: BM25 (k1=1.5, b=0.75) + similarità coseno sugli
      │   embeddings locali (nomic-embed-text via /api/embed), fusi con
      │   Reciprocal Rank Fusion; boost sul titolo del documento nominato
      ├── modalità ESTRATTIVA (default): risposta = top chunk + fonti
      ├── modalità OLLAMA (consigliata): chat conversazionale con cronologia,
      │   estratti (max ~9.000 caratteri) inviati a /api/chat in STREAMING
      │   (i token compaiono man mano), citazioni [1], [2], …
      └── impostazioni (URL Ollama, modello) in chrome.storage.local
```

**Perché queste scelte:**

- **PDF parsing nel content script, non nel service worker** — pdf.js è
  pensato per girare con un Web Worker; nei service worker MV3 non si possono
  creare Worker annidati. Nel content script carichiamo il worker di pdf.js
  come Blob URL (i Worker richiedono same-origin, quindi l'URL
  `chrome-extension://` diretto non funzionerebbe).
- **Fetch dal content script, non dal background** — le richieste partono
  dalla stessa origin della pagina, quindi i cookie di sessione vengono
  inclusi in modo naturale e non servono `host_permissions` sul dominio
  iCorsi. È anche la garanzia strutturale che l'estensione può leggere solo
  ciò che l'utente può già aprire.
- **IndexedDB nel background** — l'indice vive nell'origin dell'estensione,
  separato dal sito, e sopravvive tra le sessioni.
- **BM25 keyword invece di embeddings** — per un MVP è robusto, veloce,
  completamente locale e senza dipendenze; gli embeddings sono nel piano
  futuri sviluppi.
- **Generazione con Ollama in locale** — niente API esterne: il modello gira
  sulla tua macchina, quindi nemmeno gli estratti escono dal computer. Senza
  modello configurato l'estensione resta utile in modalità estrattiva
  (ricerca + estratti con citazioni).

## 2. Struttura del progetto

```
icorsi/
├── manifest.json            # Chrome / Edge (MV3, service worker)
├── manifest.firefox.json    # Firefox (MV3, background scripts)
├── README.md
├── src/
│   ├── content.js           # scanner, fetch, pdf.js, chunking, sidebar UI
│   ├── sidebar.css          # stile della sidebar (iniettato nello Shadow DOM)
│   └── background.js        # IndexedDB, BM25, risposta locale/Claude
└── vendor/
    ├── pdf.min.mjs          # pdf.js 4.10.38 (build legacy, vendorizzato:
    └── pdf.worker.min.mjs   #  MV3 vieta il codice remoto)
```

## 3. Setup di Ollama (per le risposte generate)

1. Installa [Ollama](https://ollama.com) e scarica un modello di chat più il
   modello di embedding per la ricerca semantica:

   ```sh
   ollama pull qwen2.5:7b          # chat, ottimo anche in italiano
   ollama pull nomic-embed-text    # embeddings (~274 MB) — ricerca semantica
   ```

   Senza `nomic-embed-text` l'estensione funziona comunque (solo BM25);
   con il modello presente, gli embeddings vengono calcolati durante la
   scansione e la ricerca diventa ibrida (keyword + semantica).

2. **Nessuna configurazione di Ollama necessaria.** Di default Ollama rifiuta
   (403) le richieste con origin `chrome-extension://`, ma l'estensione
   riscrive automaticamente l'header `Origin` in `http://localhost:11434`
   (che Ollama accetta sempre) tramite una regola `declarativeNetRequest`
   ([rules.json](rules.json)). Funziona out-of-the-box e sopravvive a riavvii
   e aggiornamenti di Ollama — non serve impostare `OLLAMA_ORIGINS`.

   <details>
   <summary>Alternativa manuale (se preferisci non usare la riscrittura)</summary>

   Disattiva la regola nel manifest e avvia Ollama con:

   ```sh
   OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*" ollama serve
   ```

   Nota: su macOS con l'app menu bar, `launchctl setenv` si è dimostrato
   inaffidabile (la variabile non sempre viene raccolta dopo i riavvii
   dell'app) — è il motivo per cui la riscrittura dell'header è il default.
   </details>

3. Nella sidebar: ⚙️ → verifica l'URL (`http://localhost:11434`), premi ↻ per
   caricare la lista dei modelli, scegline uno e salva.

Senza modello selezionato l'estensione funziona comunque in **modalità
estrattiva** (ricerca BM25 + estratti con citazioni), tutto nel browser.

## 4. Installazione in modalità developer

### Chrome / Edge / Brave

1. Apri `chrome://extensions`
2. Attiva **Modalità sviluppatore** (in alto a destra)
3. **Carica estensione non pacchettizzata** → seleziona questa cartella
4. Apri una pagina di un tuo corso su `https://www.icorsi.ch` → in basso a
   destra appare il pulsante 📚

### Firefox (121+)

1. Sostituisci il manifest: `cp manifest.firefox.json manifest.json`
   (oppure crea una copia della cartella per Firefox)
2. Apri `about:debugging#/runtime/this-firefox`
3. **Carica componente aggiuntivo temporaneo…** → seleziona `manifest.json`
4. Nota: l'estensione temporanea viene rimossa al riavvio di Firefox

### Se la tua università usa un dominio diverso

Modifica `matches` e `web_accessible_resources[].matches` nel manifest con il
dominio della tua piattaforma (es. `https://moodle.miauni.it/*`). Tieni i
match **stretti sul dominio** invece di `<all_urls>`.

## 5. Come si usa / come testarlo

1. Fai login su iCorsi normalmente e apri la pagina principale di un corso
2. Clicca 📚 → si apre la sidebar
3. **🔍 Scansiona questa pagina** — l'estensione:
   - indicizza il testo visibile della pagina (sezioni del corso)
   - trova i link ai materiali e li scarica uno alla volta (max 20 per
     scansione, 2 in parallelo, con pausa tra i download)
   - mostra un report: indicizzati / saltati / avvisi (es. PDF scansionati)
4. Fai domande in linguaggio naturale, ad esempio:
   - *"Riassumi il PDF della lezione 1"*
   - *"Dove si parla del modello Uppsala?"*
   - *"Fammi 10 domande di ripasso su questi PDF"*
5. Ogni risposta riporta le **fonti cliccabili** (titolo + pagina + link)

**Senza modello configurato** ottieni gli estratti più rilevanti con
citazioni (ricerca BM25 locale). **Con un modello Ollama selezionato** (⚙️ →
scegli il modello dalla lista) ottieni una risposta generata in locale basata
solo sugli estratti, con citazioni `[n]`. In entrambi i casi nessun dato esce
dalla tua macchina.

### Test rapido su un Moodle qualsiasi

Il rilevamento usa pattern standard Moodle (`pluginfile.php`,
`mod/resource/view.php`, `mod/page/view.php`, link `.pdf`/`.pptx`/`.docx`;
sottopagine: `mod/folder` e sezioni del corso), quindi funziona anche su
altre istanze Moodle dopo aver adattato i `matches` del manifest.
Per il debug:

- console della pagina → log del content script
- `chrome://extensions` → "service worker" → console del background
- DevTools → Application → IndexedDB → `icorsi-assistant` per ispezionare
  l'indice

## 6. Gestione errori implementata

| Caso | Comportamento |
|---|---|
| Sessione scaduta | il fetch finisce sulla pagina di login → il documento viene saltato con messaggio "Sessione scaduta: effettua di nuovo il login" |
| PDF non accessibile / HTTP 403-404 | saltato e riportato nel report di scansione |
| PDF scansionato (immagini, niente testo) | indicizzato se c'è del testo, ma segnalato con avviso (media < 40 caratteri/pagina) |
| File non supportato (zip, vecchi .ppt/.doc…) | saltato con "formato non supportato" |
| PDF > 30 MB | saltato per non saturare la memoria |
| Ollama non in esecuzione / non raggiungibile | messaggio chiaro + fallback alla modalità estrattiva |
| Ollama rifiuta la richiesta (403) | non dovrebbe più accadere (header Origin riscritto via declarativeNetRequest); se accade, il messaggio suggerisce i rimedi |
| Modello non scaricato (404) | suggerisce il comando `ollama pull <modello>` |
| Worker pdf.js bloccato dalla CSP | fallback automatico al parsing sul main thread |

## 7. Miglioramenti futuri

- ~~Embeddings locali via Ollama~~ ✅ implementato (ibrido BM25 + coseno, RRF)
- ~~Streaming della risposta nella chat~~ ✅ implementato (Port + NDJSON)
- ~~Rendering Markdown~~ ✅ implementato (renderer DOM-safe, citazioni [n] cliccabili)
- ~~Scansione incrementale~~ ✅ implementato (ETag/Last-Modified + hash SHA-256
  del contenuto: i documenti invariati non vengono ri-parsati né ri-vettorizzati)
- ~~Navigazione tra sezioni del corso~~ ✅ opzionale (Settings → "Also
  explore subpages", spento di default): esplora sezioni e cartelle Moodle
  (max 8 sottopagine). Di default si analizzano SOLO i documenti visibili
  sulla dashboard del corso; la scansione automatica parte solo lì
- ~~Supporto PPTX/DOCX~~ ✅ senza librerie esterne: mini-lettore ZIP con
  DecompressionStream nativo + parsing XML; le slide PPTX sono citate per
  numero come le pagine dei PDF
- **OCR locale** (tesseract.js) per i PDF scansionati
- ~~Quiz automatici e riassunti~~ ✅ comandi rapidi: Summary, Quiz, Key
  points, Flashcards, Oral exam, Study plan, This week
- ~~Persistenza della conversazione~~ ✅ per pagina, via sessionStorage
- ~~Supporto multilingue~~ ✅ il bot risponde nella lingua della domanda
  (IT/EN/DE/FR e altre); override fisso nelle impostazioni; interfaccia
  EN/IT col pulsante lingua nell'header
- ~~Citazioni che aprono il PDF alla pagina giusta~~ ✅ ancora `#page=N`
  (rispettata dal viewer PDF di Chrome)
- ~~Scansione automatica al cambio pagina~~ ✅ attiva di default,
  disattivabile nelle impostazioni; economica grazie all'indice incrementale
- ~~Esclusione documenti~~ ✅ lista pattern configurabile (default:
  teams.microsoft, sharepoint, mod/lti)
- ~~Riassunto settimanale~~ ✅ chip "This week": riassume i documenti visti
  per la prima volta negli ultimi 7 giorni
- ~~Scadenze del corso~~ ✅ i blocchi timeline/calendario visibili sulla
  pagina vengono passati al modello come contesto (es. "cosa studio per
  venerdì?")
- ~~Modalità "non lo so"~~ ✅ regola esplicita nel prompt: senza fonte negli
  estratti il modello lo dichiara invece di inventare
- **Citazioni cliccabili a livello di frase** (ancore `#page=N` nei viewer
  PDF) e highlight del passaggio
- **Forum**: indicizzazione dei thread `mod/forum` visibili

## 8. Limiti, privacy e note legali

- **Solo uso personale.** L'estensione agisce come "occhiali" sul browser
  dell'utente: legge solo contenuti che l'utente può già aprire con la propria
  sessione. Non modifica iCorsi, non aggira login, permessi o restrizioni di
  download, non accede a corsi a cui non sei iscritto.
- **Niente scraping aggressivo.** Limiti volutamente conservativi: max 20
  documenti per scansione, 2 download in parallelo, pausa di 300 ms tra i
  download, scansione solo su azione esplicita dell'utente. Non fare crawling
  di massa dell'intera piattaforma.
- **Termini d'uso.** Verifica i termini di servizio di iCorsi/della tua
  università: alcuni atenei vietano strumenti automatici anche per uso
  personale. Il materiale didattico è coperto da copyright: l'indicizzazione
  locale per studio personale è in genere assimilabile a salvare i PDF sul
  proprio computer, ma **non ridistribuire** né i contenuti né l'indice.
- **Dati locali, elaborazione locale.** Documenti, chunk e impostazioni
  restano nel browser (IndexedDB + chrome.storage.local); la generazione
  delle risposte avviene tramite Ollama sulla tua macchina. Nessun dato viene
  inviato a servizi esterni. Il pulsante "Cancella indice" rimuove tutto;
  rimuovendo l'estensione si rimuove anche lo storage.
- **Riscrittura dell'header Origin.** La regola declarativeNetRequest vale
  solo per le richieste verso `localhost:11434` / `127.0.0.1:11434` e
  richiede gli host_permissions corrispondenti: non tocca il traffico verso
  altri siti. Ollama resta in ascolto solo su localhost, quindi nessun
  servizio esterno può raggiungerlo.
- **Dati personali di terzi.** Anche se tutto resta in locale, evita di
  indicizzare pagine con dati di altri studenti (elenchi partecipanti, forum
  con nomi) — non servono allo scopo dello strumento.
