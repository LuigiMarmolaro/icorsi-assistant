# iCorsi Course Assistant (personal prototype)

A **personal** Manifest V3 browser extension that adds a sidebar / chatbox to
iCorsi (Moodle) pages and lets you index and query your course materials —
PDFs, `pluginfile.php` / `mod/resource` resources, `mod/page` pages, PPTX/DOCX
files, and the visible page text — **using only your already-authenticated
browser session**. Answers are generated locally via [Ollama](https://ollama.com):
no data ever leaves your machine.

> Note: personal MVP prototype. It is not an official university integration
> and is not meant to be redistributed. See [Limits, privacy & legal](#8-limits-privacy--legal).

---

## 1. Architecture

```
iCorsi page (browser, authenticated session)
│
├── content script (src/content.js) — runs only on *.icorsi.ch
│     ├── injects the sidebar/chatbox (Shadow DOM, isolated CSS)
│     ├── on "Scan this page":
│     │     ├── detects material links (.pdf/.pptx/.docx, pluginfile.php,
│     │     │   mod/resource, mod/page) — same-origin only
│     │     ├── fetch with credentials: 'include' (session cookies are used
│     │     │   automatically; no bypass of any protection)
│     │     ├── pdf.js (vendored) extracts text page by page
│     │     ├── native ZIP reader (DecompressionStream) extracts PPTX/DOCX text
│     │     ├── DOMParser extracts text from HTML pages
│     │     └── chunking (~1200 chars, 200 overlap, sentence-boundary cut)
│     └── sends doc + chunks to the background via chrome.runtime
│
└── background service worker (src/background.js)
      ├── IndexedDB (extension origin): 'docs' and 'chunks' stores
      │   (precomputed term-frequency + per-chunk embedding when available)
      ├── HYBRID search: BM25 (k1=1.5, b=0.75) + cosine similarity over local
      │   embeddings (nomic-embed-text via /api/embed), fused with Reciprocal
      │   Rank Fusion; title boost for the named document; similarity threshold
      │   to drop irrelevant matches
      ├── EXTRACTIVE mode (default): answer = top chunks + sources
      ├── OLLAMA mode (recommended): conversational chat with history, excerpts
      │   (max ~9,000 chars) sent to /api/chat with STREAMING (tokens appear as
      │   they are generated), citations [1], [2], …
      └── settings (Ollama URL, model, language, exclusions) in chrome.storage
```

**Why these choices:**

- **PDF parsing in the content script, not the service worker** — pdf.js is
  built to run with a Web Worker; MV3 service workers cannot spawn nested
  Workers. In the content script the pdf.js worker is loaded as a Blob URL
  (Workers require same-origin, so a direct `chrome-extension://` URL would not
  work).
- **Fetching from the content script, not the background** — requests originate
  from the page's own origin, so session cookies are included naturally and no
  `host_permissions` on the iCorsi domain are needed. It is also the structural
  guarantee that the extension can only read what the user can already open.
- **IndexedDB in the background** — the index lives in the extension origin,
  separate from the site, and persists across sessions.
- **Hybrid BM25 + embeddings** — BM25 is robust and dependency-free; the local
  embeddings (via Ollama) add true semantic search. Both are fused with RRF.
- **Local generation with Ollama** — no external APIs: the model runs on your
  machine, so not even the excerpts leave the computer. Without a configured
  model the extension still works in extractive mode (search + cited excerpts).

## 2. Project structure

```
icorsi/
├── manifest.json            # Chrome / Edge (MV3, service worker)
├── manifest.firefox.json    # Firefox (MV3, background scripts)
├── rules.json               # declarativeNetRequest: Origin rewrite for Ollama
├── README.md
├── src/
│   ├── content.js           # scanner, fetch, pdf.js/ZIP, chunking, sidebar UI, i18n
│   ├── sidebar.css           # sidebar styling (injected into the Shadow DOM)
│   └── background.js        # IndexedDB, hybrid search, Ollama chat/embeddings
└── vendor/
    ├── pdf.min.mjs          # pdf.js 4.10.38 (legacy build, vendored:
    └── pdf.worker.min.mjs   #  MV3 forbids remote code)
```

## 3. Ollama setup (for generated answers)

1. Install [Ollama](https://ollama.com) and pull a chat model plus the
   embedding model used for semantic search:

   ```sh
   ollama pull qwen2.5:7b          # chat, strong in many languages
   ollama pull nomic-embed-text    # embeddings (~274 MB) — semantic search
   ```

   Without `nomic-embed-text` the extension still works (BM25 only); with the
   model present, embeddings are computed during scanning and search becomes
   hybrid (keyword + semantic).

2. **No Ollama configuration needed.** By default Ollama rejects (403) requests
   with a `chrome-extension://` origin, but the extension automatically
   rewrites the `Origin` header to `http://localhost:11434` (which Ollama
   always accepts) via a `declarativeNetRequest` rule ([rules.json](rules.json)).
   This works out of the box and survives Ollama restarts and updates — you do
   not need to set `OLLAMA_ORIGINS`.

   <details>
   <summary>Manual alternative (if you prefer not to rewrite the header)</summary>

   Disable the rule in the manifest and start Ollama with:

   ```sh
   OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*" ollama serve
   ```

   Note: on macOS with the menu-bar app, `launchctl setenv` proved unreliable
   (the variable is not always picked up after app restarts) — which is why the
   header rewrite is the default.
   </details>

3. In the sidebar: open Settings, check the URL (`http://localhost:11434`),
   press the refresh button to load the model list, pick one, and save.

Without a selected model the extension still works in **extractive mode** (BM25
search + cited excerpts), entirely in the browser.

## 4. Developer-mode installation

### Chrome / Edge / Brave

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Open one of your courses on `https://www.icorsi.ch` → the floating **AI**
   button appears at the bottom right

### Firefox (121+)

1. Swap the manifest: `cp manifest.firefox.json manifest.json`
   (or keep a separate copy of the folder for Firefox)
2. Open `about:debugging#/runtime/this-firefox`
3. **Load Temporary Add-on…** → select `manifest.json`
4. Note: temporary add-ons are removed when Firefox restarts

### If your university uses a different domain

Edit `matches` and `web_accessible_resources[].matches` in the manifest with
your platform's domain (e.g. `https://moodle.myuni.edu/*`). Keep the matches
**tight to the domain** instead of `<all_urls>`.

## 5. Usage / how to test

1. Log in to iCorsi normally and open a course's main page (the dashboard)
2. Click the **AI** button → the sidebar opens
3. **Scan this page** — the extension:
   - indexes the visible page text (course sections)
   - finds material links and downloads them one at a time (max 20 per scan, 2
     in parallel, with a pause between downloads)
   - shows a report: indexed / skipped / warnings (e.g. scanned PDFs)
   - by default only the documents visible on the course dashboard are
     analyzed; subpage exploration (sections, folders) is opt-in in Settings
4. Ask questions in natural language, for example:
   - *"Summarize the lesson 1 PDF"*
   - *"Where is the Uppsala model discussed?"*
   - *"Give me 10 review questions on these PDFs"*
5. Every answer includes **clickable sources** (title + page + link). For PDFs
   the link uses a `#page=N` anchor, so Chrome's PDF viewer opens directly at
   the cited page.

**Quick actions** (chips above the input): Summary, Quiz, Key points,
Flashcards, Oral exam, Study plan, This week.

**Without a configured model** you get the most relevant cited excerpts (local
BM25/semantic search). **With an Ollama model selected** you get a locally
generated answer grounded only in the excerpts, with `[n]` citations. Either
way, no data leaves your machine.

### Interface language

The UI defaults to English. Use the **EN/IT** button in the header to switch the
interface language (preference is saved). Answers follow the language of your
question by default, or can be fixed to a specific language in Settings.

### Quick test on any Moodle

Detection uses standard Moodle patterns (`pluginfile.php`,
`mod/resource/view.php`, `mod/page/view.php`, `.pdf`/`.pptx`/`.docx` links;
subpages: `mod/folder` and course sections), so it also works on other Moodle
instances after adjusting the manifest `matches`. For debugging:

- page console → content-script logs
- `chrome://extensions` → "service worker" → background console
- DevTools → Application → IndexedDB → `icorsi-assistant` to inspect the index

## 6. Error handling

| Case | Behavior |
|---|---|
| Expired session | the fetch lands on the login page → the document is skipped with "Session expired: log in to iCorsi again" |
| Inaccessible PDF / HTTP 403-404 | skipped and reported in the scan report |
| Scanned PDF (images, no text) | indexed if any text is present, but flagged with a warning (avg < 40 chars/page) |
| Unsupported file (zip, legacy .ppt/.doc…) | skipped with "unsupported format" |
| File > 30 MB | skipped to avoid saturating memory |
| Ollama not running / unreachable | clear message + fallback to extractive mode |
| Ollama rejects the request (403) | should no longer happen (Origin header rewritten via declarativeNetRequest); if it does, the message suggests fixes |
| Model not pulled (404) | suggests the `ollama pull <model>` command |
| pdf.js worker blocked by CSP | automatic fallback to main-thread parsing |

## 7. Feature set

- Hybrid retrieval: BM25 + local embedding cosine similarity (nomic-embed-text),
  fused with RRF, with a relevance threshold and small-talk gating
- Streaming chat answers (Port + NDJSON), Markdown rendering (DOM-safe)
- Clickable citations that open the PDF at the right page (`#page=N`)
- Incremental indexing (ETag/Last-Modified + SHA-256 content hash: unchanged
  documents are not re-parsed or re-embedded)
- PDF, PPTX, DOCX and HTML extraction (PPTX/DOCX via a native ZIP reader, no
  external libraries; PPTX slides cited by number like PDF pages)
- Optional subpage exploration (sections and folders); by default only the
  course dashboard is analyzed, and auto-scan runs only there
- Exam-mode quick actions: Summary, Quiz, Key points, Flashcards, Oral exam,
  Study plan, weekly recap ("This week")
- Course-deadline context (visible timeline/calendar blocks are passed to the
  model, e.g. "what should I study for Friday?")
- "I don't know" mode: the model states when the indexed materials don't cover
  the question instead of inventing an answer
- Multilingual answers (follows the question, or fixed in Settings); EN/IT
  interface toggle
- Per-page conversation persistence (sessionStorage)
- Document exclusion list (default: teams.microsoft, sharepoint, mod/lti,
  panopto…), applied retroactively to the existing index

## 8. Limits, privacy & legal

- **Personal use only.** The extension acts as "glasses" over the user's
  browser: it reads only content the user can already open with their own
  session. It does not modify iCorsi, does not bypass login, permissions or
  download restrictions, and does not access courses you are not enrolled in.
