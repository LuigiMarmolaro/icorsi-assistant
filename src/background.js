// iCorsi Course Assistant — background service worker
// Responsabilità: storage locale (IndexedDB), ricerca BM25 sui chunk,
// generazione risposta (estrattiva, oppure tramite un modello locale servito
// da Ollama — tutto resta sulla macchina dell'utente).

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

const DB_NAME = 'icorsi-assistant';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) {
        db.createObjectStore('docs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const store = db.createObjectStore('chunks', { autoIncrement: true });
        store.createIndex('byDoc', 'docId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, stores, mode) {
  return db.transaction(stores, mode);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteChunksForDoc(db, docId) {
  const t = tx(db, ['chunks'], 'readwrite');
  const idx = t.objectStore('chunks').index('byDoc');
  const keys = await reqToPromise(idx.getAllKeys(IDBKeyRange.only(docId)));
  for (const k of keys) t.objectStore('chunks').delete(k);
  return new Promise((res, rej) => {
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
}

async function indexDocument(doc, chunks, ollamaUrl) {
  // Embeddings best-effort, calcolati PRIMA della transazione (le fetch non
  // possono stare dentro una transazione IndexedDB attiva). Se il modello di
  // embedding non c'è o Ollama è giù, si indicizza comunque senza vettori.
  let vecs = null;
  if (chunks.length > 0 && (await isEmbedAvailable(ollamaUrl))) {
    try {
      vecs = await embedTexts(chunks.map((c) => c.text), ollamaUrl, 'search_document: ');
    } catch (e) {
      console.warn('[iCorsi Assistant] embeddings saltati per questo documento:', e.message);
    }
  }

  const db = await openDb();
  // 'firstSeen' resta quello della prima indicizzazione: serve per
  // "riassumi i materiali di questa settimana"
  const existing = await getDoc(doc.id);
  await deleteChunksForDoc(db, doc.id);
  const t = tx(db, ['docs', 'chunks'], 'readwrite');
  // 'embedded' permette alla scansione incrementale di re-indicizzare i
  // documenti rimasti senza vettori (es. embeddings attivati in seguito)
  t.objectStore('docs').put({
    ...doc,
    embedded: !!vecs,
    indexedAt: Date.now(),
    firstSeen: existing?.firstSeen || Date.now(),
  });
  chunks.forEach((c, i) => {
    const { tf, len } = tokenizeToTf(c.text);
    t.objectStore('chunks').add({ ...c, tf, len, vec: vecs ? vecs[i] : null });
  });
  await new Promise((res, rej) => {
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
  chunksCache = null; // invalida la cache di ricerca
}

async function getAllChunks() {
  const db = await openDb();
  const t = tx(db, ['chunks'], 'readonly');
  return reqToPromise(t.objectStore('chunks').getAll());
}

async function getAllDocs() {
  const db = await openDb();
  const t = tx(db, ['docs'], 'readonly');
  return reqToPromise(t.objectStore('docs').getAll());
}

async function getDoc(id) {
  const db = await openDb();
  const t = tx(db, ['docs'], 'readonly');
  return reqToPromise(t.objectStore('docs').get(id));
}

async function deleteDocAndChunks(id) {
  const db = await openDb();
  await deleteChunksForDoc(db, id);
  const t = tx(db, ['docs'], 'readwrite');
  t.objectStore('docs').delete(id);
  await new Promise((res, rej) => {
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
  chunksCache = null;
}

async function clearIndex() {
  const db = await openDb();
  const t = tx(db, ['docs', 'chunks'], 'readwrite');
  t.objectStore('docs').clear();
  t.objectStore('chunks').clear();
  await new Promise((res, rej) => {
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
  chunksCache = null;
}

// ---------------------------------------------------------------------------
// Tokenizzazione + BM25
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  // italiano
  'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'il', 'lo', 'la',
  'le', 'gli', 'un', 'una', 'uno', 'che', 'chi', 'cui', 'non', 'come', 'dove',
  'quando', 'quale', 'quali', 'questo', 'questa', 'questi', 'queste', 'quello',
  'quella', 'sono', 'sia', 'del', 'della', 'dello', 'dei', 'delle', 'degli',
  'al', 'alla', 'allo', 'ai', 'alle', 'agli', 'dal', 'dalla', 'nel', 'nella',
  'nei', 'nelle', 'sul', 'sulla', 'ed', 'od', 'anche', 'più', 'piu', 'ma',
  'se', 'si', 'mi', 'ti', 'ci', 'vi', 'ne', 'è', 'ha', 'ho', 'hanno',
  // inglese
  'the', 'a', 'an', 'of', 'to', 'and', 'or', 'in', 'on', 'at', 'is', 'are',
  'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those',
  'with', 'as', 'by', 'for', 'from', 'not', 'but', 'what', 'which', 'who',
  'when', 'where', 'how', 'can', 'will', 'would', 'there', 'their', 'they',
  // tedesco
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem',
  'einer', 'und', 'oder', 'aber', 'ist', 'sind', 'war', 'waren', 'sein',
  'nicht', 'mit', 'von', 'zu', 'im', 'am', 'auf', 'für', 'fur', 'als', 'auch',
  'wie', 'wo', 'wann', 'wer', 'dass', 'weil', 'wenn', 'bei', 'nach', 'über',
  'uber', 'unter', 'durch', 'um', 'aus', 'es', 'er', 'wir', 'ihr', 'ich',
  'du', 'man', 'sich', 'noch', 'nur', 'schon', 'sehr', 'kann', 'können',
  'konnen', 'wird', 'werden', 'hat', 'haben', 'hatte',
  // francese
  'le', 'les', 'une', 'du', 'et', 'ou', 'mais', 'est', 'sont', 'était',
  'etait', 'dans', 'sur', 'pour', 'par', 'avec', 'sans', 'que', 'qui',
  'quoi', 'dont', 'où', 'ou', 'quand', 'comment', 'pourquoi', 'ce', 'cette',
  'ces', 'cela', 'ça', 'ca', 'pas', 'plus', 'très', 'tres', 'aussi', 'comme',
  'au', 'aux', 'elle', 'ils', 'elles', 'nous', 'vous', 'je', 'tu', 'on',
  'sa', 'son', 'ses', 'leur', 'leurs', 'notre', 'votre', 'être', 'etre',
  'avoir', 'ont', 'avait', 'peut',
]);

function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // rimuove accenti per match accent-insensitive
}

function tokenize(text) {
  return normalizeText(text)
    // separa lettere e cifre: "lesson1" → "lesson 1", così matcha "Lesson 1"
    .replace(/([a-z])(?=\d)/g, '$1 ')
    .replace(/(\d)(?=[a-z])/g, '$1 ')
    .split(/[^a-z0-9]+/)
    // i numeri restano anche a una cifra ("lezione 1", "capitolo 3")
    .filter((w) => w && !STOPWORDS.has(w) && (w.length > 1 || /^\d$/.test(w)));
}

function tokenizeToTf(text) {
  const tokens = tokenize(text);
  // Object.create(null): evita collisioni con Object.prototype per parole
  // come "constructor" o "toString" presenti nei testi
  const tf = Object.create(null);
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return { tf, len: tokens.length };
}

// Lettura sicura della term-frequency: dopo il round-trip in IndexedDB la
// mappa torna come oggetto con Object.prototype, quindi tf['constructor']
// restituirebbe una funzione invece di 0.
function tfGet(tf, term) {
  return Object.prototype.hasOwnProperty.call(tf, term) ? tf[term] : 0;
}

// ---------------------------------------------------------------------------
// Embeddings — ricerca semantica locale via Ollama (opzionale)
// ---------------------------------------------------------------------------

const EMBED_MODEL = 'nomic-embed-text';

function l2normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

// vettori normalizzati → la similarità coseno è un semplice prodotto scalare
function dot(a, b) {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

let embedAvailableCache = null;
async function isEmbedAvailable(ollamaUrl) {
  if (embedAvailableCache !== null) return embedAvailableCache;
  try {
    const models = await listOllamaModels(ollamaUrl);
    embedAvailableCache = models.some((m) => m.startsWith(EMBED_MODEL));
  } catch (_) {
    embedAvailableCache = false;
  }
  // la cache scade: l'utente potrebbe fare "ollama pull" nel frattempo
  setTimeout(() => (embedAvailableCache = null), 60000);
  return embedAvailableCache;
}

// nomic-embed-text è addestrato con prefissi di ruolo: usarli migliora
// nettamente la separazione tra risultati pertinenti e non pertinenti
async function embedTexts(texts, ollamaUrl, prefix) {
  const baseUrl = (ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
  const out = [];
  const BATCH = 16;
  for (let i = 0; i < texts.length; i += BATCH) {
    const resp = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: texts.slice(i, i + BATCH).map((t2) => (prefix || '') + t2),
      }),
    });
    if (!resp.ok) throw new Error(`embed HTTP ${resp.status}`);
    const data = await resp.json();
    for (const v of data.embeddings || []) out.push(l2normalize(v));
  }
  return out;
}

let chunksCache = null;

// Versione dello schema di indicizzazione: da incrementare quando cambia il
// tokenizer o la struttura dei chunk. Gli indici costruiti con una versione
// precedente vengono svuotati (sono ricostruibili con una scansione), invece
// di degradare silenziosamente la qualità della ricerca.
const INDEX_SCHEMA_VERSION = 4; // v4: embeddings con prefissi nomic
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const { indexSchemaVersion } = await chrome.storage.local.get('indexSchemaVersion');
      if (indexSchemaVersion !== INDEX_SCHEMA_VERSION) {
        await clearIndex();
        await chrome.storage.local.set({ indexSchemaVersion: INDEX_SCHEMA_VERSION });
        console.info(
          '[iCorsi Assistant] schema indice aggiornato: indice svuotato, serve una nuova scansione'
        );
      }
    })();
  }
  return schemaReady;
}

// Convenevoli: per questi messaggi non va fatto ALCUN retrieval — la chat
// deve rispondere in modo conversazionale, senza trascinare estratti a caso
const SMALLTALK = new Set([
  'ciao', 'salve', 'hello', 'hi', 'hey', 'hola', 'yo', 'ola',
  'buongiorno', 'buonasera', 'buonanotte', 'buondi',
  'grazie', 'thanks', 'thank', 'thx', 'danke', 'merci',
  'ok', 'okay', 'bene', 'perfetto', 'ottimo', 'great', 'cool', 'nice',
  'bye', 'arrivederci', 'addio', 'goodbye', 'ciaociao',
  'bonjour', 'bonsoir', 'hallo', 'salut', 'tschuss', 'prego', 'please',
  'test', 'prova',
]);

async function searchChunks(query, topK = 8, ollamaUrl) {
  if (!chunksCache) chunksCache = await getAllChunks();
  const chunks = chunksCache;
  if (chunks.length === 0) return [];

  const qTokens = [...new Set(tokenize(query))];
  if (qTokens.length === 0) return [];
  if (qTokens.every((tk) => SMALLTALK.has(tk))) return [];

  const N = chunks.length;
  const avgLen = chunks.reduce((s, c) => s + c.len, 0) / N || 1;

  // document frequency per termine della query
  const df = Object.create(null);
  for (const t of qTokens) {
    df[t] = chunks.reduce((s, c) => s + (tfGet(c.tf, t) > 0 ? 1 : 0), 0);
  }

  const k1 = 1.5;
  const b = 0.75;

  // Retrieval guidato dal titolo: se la query nomina un documento
  // ("lesson 1", "riassumi il pdf di RSA"), i chunk di quel documento vanno
  // inclusi anche se il testo non matcha (es. richieste di riassunto).
  const docs = await getAllDocs();
  let bestDoc = null;
  let bestFrac = 0;
  for (const d of docs) {
    const titleTokens = new Set(tokenize(d.title || ''));
    if (titleTokens.size === 0) continue;
    const hits = qTokens.filter((t) => titleTokens.has(t)).length;
    const frac = hits / qTokens.length;
    if (frac > bestFrac || (frac === bestFrac && bestDoc && titleTokens.size < tokenize(bestDoc.title).length)) {
      bestFrac = frac;
      bestDoc = d;
    }
  }
  const titleDocId = bestFrac >= 0.5 ? bestDoc.id : null;

  const scored = chunks.map((c) => {
    let score = 0;
    for (const t of qTokens) {
      const f = tfGet(c.tf, t);
      if (f === 0) continue;
      const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (c.len / avgLen))));
    }
    if (c.docId === titleDocId) {
      // garantisce che i chunk del documento nominato entrino nei risultati
      // (anche con testo non matchante) e che salgano in classifica
      score = (score + 0.5) * 2;
    }
    return { chunk: c, score };
  });

  const bmRanked = scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, topK * 3);

  // Ricerca semantica (se i chunk hanno embeddings e il modello è attivo):
  // fusione RRF tra ranking BM25 e ranking per similarità coseno. RRF non
  // richiede di calibrare le scale dei due punteggi.
  let fused = bmRanked;
  const withVec = chunks.filter((c) => Array.isArray(c.vec) && c.vec.length > 0);
  if (withVec.length > 0 && (await isEmbedAvailable(ollamaUrl))) {
    try {
      const [qv] = await embedTexts([query], ollamaUrl, 'search_query: ');
      // Soglia minima di similarità: senza, il coseno restituisce SEMPRE i
      // top-K più vicini, anche per messaggi che non c'entrano nulla con i
      // materiali. Se il BM25 non ha trovato alcun riscontro keyword, la
      // soglia è più severa (calibrata empiricamente su nomic-embed-text:
  // pertinente ~0.7+, non pertinente ~0.4-0.6).
      const minSim = bmRanked.length > 0 ? 0.5 : 0.62;
      const vecRanked = withVec
        .map((c) => ({ chunk: c, score: dot(qv, c.vec) }))
        .filter((r) => r.score >= minSim)
        .sort((a, b2) => b2.score - a.score)
        .slice(0, topK * 3);
      const K = 60;
      const acc = new Map();
      for (const list of [bmRanked, vecRanked]) {
        list.forEach((r, rank) => {
          acc.set(r.chunk, (acc.get(r.chunk) || 0) + 1 / (K + rank + 1));
        });
      }
      fused = [...acc.entries()]
        .map(([chunk, score]) => ({ chunk, score }))
        .sort((a, b2) => b2.score - a.score);
    } catch (e) {
      console.warn('[iCorsi Assistant] ricerca semantica fallita, uso solo BM25:', e.message);
    }
  }

  let results = fused.slice(0, topK);

  // Fallback a sottostringa: se il BM25 non trova nulla (acronimi, parole
  // flesse, tokenizzazione diversa) cerca i termini come sottostringhe nel
  // testo normalizzato. Così "trova" matcha "trovare" e "doi" matcha
  // "doi.org" anche quando i token non coincidono.
  if (results.length === 0) {
    const needles = qTokens.filter((t) => t.length >= 3);
    if (needles.length > 0) {
      results = chunks
        .map((c) => {
          const norm = normalizeText(c.text);
          const hits = needles.filter((n) => norm.includes(n)).length;
          return { chunk: c, score: hits };
        })
        .filter((s) => s.score > 0)
        .sort((a, b2) => b2.score - a.score)
        .slice(0, topK);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Generazione risposta
// ---------------------------------------------------------------------------

// Tetto sugli estratti passati al modello: i modelli locali hanno finestre di
// contesto ridotte (~9.000 caratteri ≈ 2.500 token, sicuro con num_ctx 8192).
const MAX_EXCERPT_CHARS = 9000;
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

function formatSources(results) {
  return results.map((r, i) => ({
    n: i + 1,
    title: r.chunk.title,
    page: r.chunk.page,
    section: r.chunk.section || null,
    url: r.chunk.url,
    snippet: r.chunk.text.slice(0, 220),
  }));
}

async function answerLocal(question, results, reason) {
  if (results.length === 0) {
    // Diagnostica: distingue "indice vuoto" da "nessun match"
    const docs = await getAllDocs();
    if (!chunksCache) chunksCache = await getAllChunks();
    const answer =
      docs.length === 0
        ? 'The index is empty: no documents have been indexed yet. ' +
          'Open the course page and press "Scan this page", then check in the ' +
          'report that documents were indexed and not skipped.'
        : `No relevant passages found for this question ` +
          `(current index: ${docs.length} documents, ${chunksCache.length} excerpts: ` +
          docs.slice(0, 5).map((d) => `"${d.title}"`).join(', ') +
          `${docs.length > 5 ? ', …' : ''}). ` +
          'Try more specific keywords or scan other course pages.';
    return { mode: 'local', answer, sources: [] };
  }
  const lines = results.map((r, i) => {
    const loc = r.chunk.page ? `p. ${r.chunk.page}` : r.chunk.section || 'page';
    return `[${i + 1}] ${r.chunk.title} (${loc}):\n"${r.chunk.text.trim().slice(0, 400)}…"`;
  });
  const intro =
    reason ||
    'Extractive mode (no Ollama model configured): here are the most relevant excerpts.';
  return {
    mode: 'local',
    answer: `${intro}\n\n${lines.join('\n\n')}`,
    sources: formatSources(results),
  };
}

// Retrieval per il riassunto settimanale: primi chunk dei documenti visti
// per la prima volta negli ultimi 7 giorni
async function weeklyResults(limit = 12) {
  const docs = await getAllDocs();
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const recent = docs
    .filter((d) => (d.firstSeen || 0) >= weekAgo)
    .sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0));
  if (!chunksCache) chunksCache = await getAllChunks();
  const results = [];
  for (const d of recent) {
    const dchunks = chunksCache.filter((c) => c.docId === d.id).slice(0, 3);
    for (const c of dchunks) results.push({ chunk: c, score: 1 });
    if (results.length >= limit) break;
  }
  return results.slice(0, limit);
}

// Costruisce la richiesta /api/chat (condivisa tra percorso streaming e non):
// estratti entro il tetto di caratteri, prompt di sistema, cronologia.
function buildOllamaChat(question, results, settings, history, docTitles) {
  let used = 0;
  const excerpts = [];
  for (let i = 0; i < results.length; i++) {
    const c = results[i].chunk;
    const text = c.text.trim();
    if (used + text.length > MAX_EXCERPT_CHARS) break;
    used += text.length;
    const loc = c.page ? `page ${c.page}` : c.section || 'course page';
    excerpts.push(`[${i + 1}] Source: "${c.title}", ${loc}\n${text}`);
  }

  const docList = (docTitles || []).slice(0, 30).map((t) => `- ${t}`).join('\n');

  // Il prompt di sistema è in inglese: i modelli piccoli seguono meglio le
  // istruzioni in inglese e così si evita il bias verso una lingua fissa.
  // La lingua di risposta segue l'utente (o l'override nelle impostazioni).
  const LANG_NAMES = { it: 'Italian', en: 'English', de: 'German', fr: 'French' };
  const langRule =
    settings.answerLang && LANG_NAMES[settings.answerLang]
      ? `ALWAYS answer in ${LANG_NAMES[settings.answerLang]}, regardless of the language of the question or of the excerpts.`
      : 'ALWAYS answer in the same language as the user\'s LATEST message — Italian, English, German, French or any other language they use — regardless of the language of the excerpts or of this prompt. If the user switches language mid-conversation, switch with them.';

  const deadlines = settings.pageContext
    ? `\n\nUPCOMING EVENTS / DEADLINES visible on the course page:\n${String(settings.pageContext).slice(0, 1500)}\n`
    : '';

  const system =
    'You are the study assistant embedded in the course page (iCorsi/Moodle e-learning platform). ' +
    'Chat naturally, in a friendly and concise way. You have a local index of the course materials.\n' +
    langRule +
    '\n\n' +
    `INDEXED DOCUMENTS:\n${docList || '(none)'}` +
    deadlines +
    '\n\n' +
    'Rules:\n' +
    '- When the message includes an EXCERPTS section, base your answer on those excerpts and cite sources as [1], [2], …\n' +
    '- Excerpts are retrieved automatically by similarity search and may be off-topic: silently ignore any excerpt that is not relevant to the user\'s message, and never bring up excerpt topics the user did not ask about.\n' +
    '- Never invent course content. If the excerpts and conversation do not contain the needed information, say clearly that you do not know based on the indexed course materials (in the user\'s language) and suggest which document to check, how to rephrase, or to scan more pages. Use outside general knowledge only if you explicitly label it as such.\n' +
    '- If the user only names a document (e.g. "lesson 1"), offer what you can do: summarize it, explain its concepts, create review questions or flashcards.\n' +
    '- Greetings, thanks and general questions ("what materials do you have?") get a natural conversational answer; use the document list when helpful.\n' +
    '- Summaries, quizzes, flashcards, study plans and review checklists must rely only on the excerpt material; when planning, use the deadlines section if present.';

  // Cronologia conversazione (già limitata lato client; qui tronchiamo i
  // singoli messaggi per non sforare la finestra di contesto)
  const histMessages = (history || [])
    .slice(-6)
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 500),
    }));

  const userContent =
    excerpts.length > 0
      ? `EXCERPTS FROM THE COURSE MATERIALS (retrieved for this message):\n\n${excerpts.join('\n\n---\n\n')}\n\nUSER MESSAGE: ${question}`
      : `(The local search found no relevant excerpts for this message.)\n\nUSER MESSAGE: ${question}`;

  const baseUrl = (settings.ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
  return {
    url: `${baseUrl}/api/chat`,
    baseUrl,
    payload: {
      model: settings.model,
      stream: false,
      options: { num_ctx: 8192 },
      messages: [
        { role: 'system', content: system },
        ...histMessages,
        { role: 'user', content: userContent },
      ],
    },
    // fonti = solo i chunk effettivamente inclusi negli estratti
    sources: formatSources(results.slice(0, excerpts.length)),
    allSources: formatSources(results),
  };
}

async function ollamaErrorMessage(resp, model) {
  let msg = `HTTP ${resp.status}`;
  try {
    const err = await resp.json();
    msg = err?.error || msg;
  } catch (_) { /* corpo non JSON */ }
  if (resp.status === 403) {
    msg =
      'Ollama rejected the request (403). The extension rewrites the Origin header ' +
      'automatically: reload the extension in chrome://extensions and retry. ' +
      'If it persists, start Ollama with OLLAMA_ORIGINS="chrome-extension://*".';
  }
  if (resp.status === 404 && /model/i.test(msg)) {
    msg = `Model "${model}" not found: download it with "ollama pull ${model}".`;
  }
  return msg;
}

// Percorso non-streaming (usato dal vecchio messaggio ASK, tenuto come riserva)
async function answerWithOllama(question, results, settings, history, docTitles) {
  const req = buildOllamaChat(question, results, settings, history, docTitles);

  let resp;
  try {
    resp = await fetch(req.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req.payload),
    });
  } catch (e) {
    const fallback = await answerLocal(
      question,
      results,
      `Ollama is not reachable at ${req.baseUrl} (${e.message}). ` +
        'Make sure the Ollama app is running. ' +
        'Meanwhile, here are the most relevant excerpts:'
    );
    return { ...fallback, mode: 'error' };
  }

  if (!resp.ok) {
    return {
      mode: 'error',
      answer: `Ollama error: ${await ollamaErrorMessage(resp, settings.model)}`,
      sources: req.allSources,
    };
  }

  const data = await resp.json();
  return {
    mode: 'ollama',
    answer: data?.message?.content || '(empty answer)',
    sources: req.sources,
  };
}

async function listOllamaModels(ollamaUrl) {
  const baseUrl = (ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
  const resp = await fetch(`${baseUrl}/api/tags`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.models || []).map((m) => m.name);
}

// ---------------------------------------------------------------------------
// Router dei messaggi
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      await ensureSchema();
      switch (msg.type) {
        case 'INDEX_DOC': {
          const { ollamaUrl } = await chrome.storage.local.get(['ollamaUrl']);
          await indexDocument(msg.doc, msg.chunks, ollamaUrl);
          sendResponse({ ok: true });
          break;
        }
        case 'ASK': {
          const { ollamaUrl, model, answerLang } = await chrome.storage.local.get([
            'ollamaUrl', 'model', 'answerLang',
          ]);
          const results = await searchChunks(msg.question, 8, ollamaUrl);
          let out;
          if (model) {
            const docs = await getAllDocs();
            out = await answerWithOllama(
              msg.question,
              results,
              { ollamaUrl, model, answerLang },
              msg.history || [],
              docs.map((d) => d.title)
            );
          } else {
            out = await answerLocal(msg.question, results);
          }
          sendResponse({ ok: true, ...out });
          break;
        }
        case 'LIST_MODELS': {
          const { ollamaUrl } = await chrome.storage.local.get(['ollamaUrl']);
          const models = await listOllamaModels(msg.ollamaUrl || ollamaUrl);
          sendResponse({ ok: true, models });
          break;
        }
        case 'GET_DOC': {
          sendResponse({ ok: true, doc: (await getDoc(msg.docId)) || null });
          break;
        }
        case 'CHECK_DOC': {
          // Scansione incrementale: il documento è "invariato" se l'hash del
          // contenuto coincide — ma va re-indicizzato se all'epoca era stato
          // salvato senza embeddings e ora il modello di embedding è attivo.
          const doc = await getDoc(msg.docId);
          let unchanged = !!(doc && doc.contentHash && doc.contentHash === msg.contentHash);
          if (unchanged && !doc.embedded) {
            const { ollamaUrl } = await chrome.storage.local.get(['ollamaUrl']);
            if (await isEmbedAvailable(ollamaUrl)) unchanged = false;
          }
          sendResponse({ ok: true, unchanged });
          break;
        }
        case 'GET_STATS': {
          const docs = await getAllDocs();
          if (!chunksCache) chunksCache = await getAllChunks();
          sendResponse({ ok: true, docs: docs.length, chunks: chunksCache.length, list: docs });
          break;
        }
        case 'REMOVE_MATCHING': {
          // Pulizia retroattiva: rimuove dall'indice i documenti che ora
          // ricadono nella lista di esclusione (URL o titolo)
          const patterns = (msg.patterns || [])
            .map((p) => String(p).trim().toLowerCase())
            .filter(Boolean);
          const removed = [];
          if (patterns.length > 0) {
            for (const d of await getAllDocs()) {
              const hay = `${d.url || ''} ${d.title || ''}`.toLowerCase();
              if (patterns.some((p) => hay.includes(p))) {
                await deleteDocAndChunks(d.id);
                removed.push(d.title);
              }
            }
          }
          sendResponse({ ok: true, removed });
          break;
        }
        case 'CLEAR_INDEX': {
          await clearIndex();
          sendResponse({ ok: true });
          break;
        }
        case 'GET_SETTINGS': {
          const s = await chrome.storage.local.get(['ollamaUrl', 'model', 'answerLang']);
          sendResponse({ ok: true, settings: s });
          break;
        }
        case 'SET_SETTINGS': {
          await chrome.storage.local.set(msg.settings);
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Tipo messaggio sconosciuto: ${msg.type}` });
      }
    } catch (e) {
      console.error('[iCorsi Assistant] errore nel background:', msg.type, e);
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // risposta asincrona
});

// ---------------------------------------------------------------------------
// Chat in streaming via Port: i token arrivano man mano che il modello li
// genera — essenziale con i modelli locali, dove la risposta completa può
// richiedere decine di secondi. Il Port tiene vivo il service worker.
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ica-ask') return;

  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
  });
  const post = (m) => {
    if (disconnected) return;
    try {
      port.postMessage(m);
    } catch (_) {
      disconnected = true;
    }
  };

  port.onMessage.addListener(async (msg) => {
    try {
      await ensureSchema();
      const { ollamaUrl, model, answerLang } = await chrome.storage.local.get([
        'ollamaUrl', 'model', 'answerLang',
      ]);
      // 'weekly' (riassunto settimanale) bypassa la ricerca: il contesto sono
      // i documenti visti per la prima volta negli ultimi 7 giorni
      const results = msg.weekly
        ? await weeklyResults()
        : await searchChunks(msg.question, 8, ollamaUrl);

      if (msg.weekly && results.length === 0) {
        post({
          type: 'done',
          mode: 'local',
          answer:
            'No new materials in the last 7 days (based on when documents were first indexed). ' +
            'Scan the course page after new uploads to keep the weekly recap meaningful.',
          sources: [],
        });
        return;
      }

      if (!model) {
        post({ type: 'done', ...(await answerLocal(msg.question, results)) });
        return;
      }

      const docs = await getAllDocs();
      const req = buildOllamaChat(
        msg.question,
        results,
        { ollamaUrl, model, answerLang, pageContext: msg.pageContext || '' },
        msg.history || [],
        docs.map((d) => d.title)
      );
      req.payload.stream = true;

      let resp;
      try {
        resp = await fetch(req.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req.payload),
        });
      } catch (e) {
        const fb = await answerLocal(
          msg.question,
          results,
          `Ollama is not reachable at ${req.baseUrl} (${e.message}). ` +
            'Make sure the Ollama app is running. ' +
            'Meanwhile, here are the most relevant excerpts:'
        );
        post({ type: 'done', ...fb, mode: 'error' });
        return;
      }

      if (!resp.ok) {
        post({
          type: 'done',
          mode: 'error',
          answer: `Ollama error: ${await ollamaErrorMessage(resp, model)}`,
          sources: req.allSources,
        });
        return;
      }

      // Ollama in streaming risponde con NDJSON: un oggetto JSON per riga
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let full = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (disconnected) {
          reader.cancel().catch(() => {});
          return;
        }
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const j = JSON.parse(line);
            const piece = j?.message?.content || '';
            if (piece) {
              full += piece;
              post({ type: 'delta', text: piece });
            }
          } catch (_) { /* riga incompleta, arriverà col prossimo chunk */ }
        }
      }
      post({
        type: 'done',
        mode: 'ollama',
        answer: full || '(empty answer)',
        sources: req.sources,
      });
    } catch (e) {
      console.error('[iCorsi Assistant] errore nello streaming:', e);
      post({ type: 'done', mode: 'error', answer: `Error: ${e.message}`, sources: [] });
    }
  });
});
