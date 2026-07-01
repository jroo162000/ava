// financeKnowledge.js — finance / bookkeeping / tax RAG harness.
// A DEDICATED, OpenAI-embedded vector index for high-accuracy retrieval (falls back to a local
// hashed embedding if no OpenAI key). De-duplicated ingestion (re-runs never bloat). A per-source
// progress tracker + an auto-refreshing background populator that runs every few hours, RETRIES
// sources it missed/failed, and REFRESHES stale ones — so the corpus keeps growing and stays current.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import toolsService from './tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_PATH = path.join(__dirname, '..', '..', '..', 'ava-integration', 'memory', 'finance-kb.jsonl');
const PROGRESS_PATH = path.join(__dirname, '..', '..', '..', 'ava-integration', 'memory', 'finance-kb-progress.json');
const SOURCES_PATH = path.join(__dirname, 'finance-sources.json');
const STATES_PATH = path.join(__dirname, 'finance-sources-states.json');
const DEAD_PATH = path.join(__dirname, '..', '..', '..', 'ava-integration', 'memory', 'finance-kb-dead.json');
const REFRESH_DAYS = parseInt(process.env.AVA_FINANCE_REFRESH_DAYS || '14', 10);
const MAX_FAILS = parseInt(process.env.AVA_FINANCE_MAX_FAILS || '4', 10);   // give up on a URL after this many failed passes
const ALT_MAX = parseInt(process.env.AVA_FINANCE_ALT_MAX || '4', 10);       // alternate URLs to try per subject

// ---- dead-URL blacklist: addresses that returned nothing, so we never re-scrape them ----
let _dead = null;
function _deadUrls() {
  if (_dead) return _dead;
  try { _dead = new Set(JSON.parse(fs.readFileSync(DEAD_PATH, 'utf8'))); } catch { _dead = new Set(); }
  return _dead;
}
function _markDead(u) {
  if (!u) return; const s = _deadUrls();
  if (!s.has(u)) { s.add(u); try { fs.mkdirSync(path.dirname(DEAD_PATH), { recursive: true }); fs.writeFileSync(DEAD_PATH, JSON.stringify([...s].slice(-1000))); } catch { /* ignore */ } }
}

// ---- embeddings: OpenAI (accurate) with a local hashed fallback ----
const _D = 256;
const _stop = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'is', 'are', 'for', 'on', 'with', 'as', 'at', 'by', 'from', 'that', 'this', 'it']);
function _embedLocal(text) {
  const v = new Array(_D).fill(0);
  for (const w of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (!w || _stop.has(w)) continue;
    let h = 2166136261; for (let i = 0; i < w.length; i++) { h ^= w.charCodeAt(i); h = Math.imul(h, 16777619); }
    v[(h >>> 0) % _D] += 1;
  }
  let s = 0; for (const x of v) s += x * x; const n = Math.sqrt(s) || 1; return v.map(x => x / n);
}
async function _embedBatch(texts) {
  const key = process.env.OPENAI_API_KEY;
  if (key && texts.length) {
    try {
      const r = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.AVA_FINANCE_EMBED_MODEL || 'text-embedding-3-small', input: texts })
      });
      const j = await r.json();
      if (Array.isArray(j.data) && j.data.length === texts.length) return j.data.map(d => d.embedding);
      logger.warn('[finance-kb] openai embed unexpected response; using local');
    } catch (e) { logger.warn('[finance-kb] openai embed failed; using local', { error: e.message }); }
  }
  return texts.map(_embedLocal);
}
function _cosine(a, b) { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; }
function _hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

function chunkText(text, size = 1100, overlap = 150) {
  const clean = String(text || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
  if (!clean) return [];
  const paras = clean.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const chunks = []; let buf = '';
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > size && buf) { chunks.push(buf.trim()); buf = buf.slice(Math.max(0, buf.length - overlap)) + '\n\n' + p; }
    else { buf = buf ? buf + '\n\n' + p : p; }
  }
  if (buf.trim()) chunks.push(buf.trim());
  const out = [];
  for (const c of chunks) { if (c.length <= size * 1.5) { out.push(c); continue; } for (let i = 0; i < c.length; i += size) out.push(c.slice(i, i + size)); }
  return out;
}

// Drops scraped-page boilerplate (nav menus, footers, link lists) so it never competes with real
// tax/accounting content during retrieval.
function _isBoilerplate(text) {
  const t = String(text || '');
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 25) return true;
  const sentences = (t.match(/[.!?](\s|$)/g) || []).length;
  const lower = (t.match(/\b(the|a|an|is|are|to|of|in|for|on|with|that|this|you|your|which|when|if|may|must|file|tax|income|deduction|return)\b/gi) || []).length;
  const nav = (t.match(/\b(skip to (the )?(main )?content|site ?map|privacy (policy|notice)|accessibility|newsroom|contact us|taxpayer advocate|forms? and instructions|sign ?in|log ?in|subscribe|follow us|back to top|all rights reserved|cookie|breadcrumb)\b/gi) || []).length;
  const lines = t.split(/\n|\s-\s|•|\|/).map(s => s.trim()).filter(Boolean);
  const shortLines = lines.filter(l => l.split(/\s+/).length <= 4).length;
  const shortRatio = lines.length ? shortLines / lines.length : 0;
  if (nav >= 3 && sentences < 2) return true;             // mostly nav, no prose
  if (shortRatio > 0.6 && lines.length >= 5) return true; // link / menu list
  if (sentences === 0 && lower < 6) return true;          // no real sentences
  return false;
}

// ---- dedicated finance vector index ----
let _index = null;
function _load() {
  if (_index) return _index;
  _index = [];
  try {
    if (fs.existsSync(KB_PATH)) {
      for (const l of fs.readFileSync(KB_PATH, 'utf8').split(/\r?\n/).filter(Boolean)) {
        try { const e = JSON.parse(l); if (e && e.text) { if (!e.hash) e.hash = _hash(e.text); _index.push(e); } } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }
  return _index;
}
let _migrated = false;
async function _ensureVecs() {
  if (_migrated) return;
  let idx = _load();
  const before = idx.length;
  // Purge boilerplate AND collapse duplicate chunks (same hash ingested across runs/rewrites).
  const _seenH = new Set(); const _deduped = [];
  for (const e of idx) {
    if (_isBoilerplate(e.text)) continue;
    const h = e.hash || _hash(e.text); e.hash = h;
    if (_seenH.has(h)) continue; _seenH.add(h); _deduped.push(e);
  }
  idx = _deduped;
  _index = idx;
  const missing = idx.filter(e => !Array.isArray(e.vec) || !e.vec.length);
  if (missing.length) {
    for (let i = 0; i < missing.length; i += 64) {
      const batch = missing.slice(i, i + 64);
      const vecs = await _embedBatch(batch.map(e => e.text));
      batch.forEach((e, k) => { e.vec = vecs[k]; });
    }
  }
  if (missing.length || idx.length !== before) {
    try { fs.writeFileSync(KB_PATH, idx.map(e => JSON.stringify(e)).join('\n') + '\n'); } catch { /* ignore */ }
    logger.info('[finance-kb] cleaned + embedded', { removed: before - idx.length, embedded: missing.length });
  }
  _migrated = true;
}

export async function ingest({ text, source = '', url = '', topic = '', jurisdiction = 'US-federal', dryRun = false, maxChunks = parseInt(process.env.AVA_FINANCE_MAX_CHUNKS || '80', 10) }) {
  const chunks = chunkText(text).filter(c => c.trim().length >= 80 && !_isBoilerplate(c)).slice(0, Math.max(1, maxChunks));
  if (dryRun) return { dryRun: true, wouldStore: chunks.length, source: source || url };
  const idx = _load();
  const seen = new Set(idx.map(e => e.hash));
  const fresh = [];
  for (const c of chunks) { const h = _hash(c); if (!seen.has(h)) { seen.add(h); fresh.push({ hash: h, text: c }); } }
  if (!fresh.length) return { stored: 0, source: source || url, note: 'no new chunks (already in KB)' };
  const vecs = await _embedBatch(fresh.map(f => f.text));
  const at = new Date().toISOString(); let stored = 0;
  try { fs.mkdirSync(path.dirname(KB_PATH), { recursive: true }); } catch { /* ignore */ }
  for (let i = 0; i < fresh.length; i++) {
    const e = { hash: fresh[i].hash, text: fresh[i].text, source: source || url, url, topic, jurisdiction, retrievedAt: at, vec: vecs[i] };
    idx.push(e);
    try { fs.appendFileSync(KB_PATH, JSON.stringify(e) + '\n'); stored++; } catch { /* ignore */ }
  }
  return { stored, source: source || url, retrievedAt: at };
}

export async function search(query, k = 6) {
  try {
    await _ensureVecs();
    const idx = _load();
    if (!idx.length) return [];
    const [qv] = await _embedBatch([String(query || '')]);
    return idx.map(e => ({ ...e, score: _cosine(qv, e.vec || []) })).sort((a, b) => b.score - a.score).slice(0, k);
  } catch (e) { logger.warn('[finance-kb] search failed', { error: e.message }); return []; }
}

export function stats() {
  const idx = _load(); const src = new Set(); const jur = new Set();
  for (const e of idx) { src.add(e.source); jur.add(e.jurisdiction); }
  return { chunks: idx.length, sources: src.size, jurisdictions: jur.size };
}

// ---- per-source progress + auto-refreshing populator ----
function _readProgress() { try { return fs.existsSync(PROGRESS_PATH) ? JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8')) : {}; } catch { return {}; } }
function _writeProgress(p) { try { fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true }); fs.writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2)); } catch { /* ignore */ } }

let _pop = { running: false, total: 0, done: 0, ok: 0, failed: 0, lastSource: '', startedAt: null, finishedAt: null, mode: '' };
export function popStatus() {
  const prog = _readProgress();
  const keys = Object.keys(prog).filter(k => !k.startsWith('__'));
  const succeeded = keys.filter(k => prog[k] && prog[k].ok).length;
  const deadSources = keys.filter(k => prog[k] && prog[k].dead).length;
  return { ..._pop, kbChunks: _load().length, sourcesTracked: keys.length, sourcesSucceeded: succeeded, deadSources, deadUrls: _deadUrls().size };
}

async function _scrapeText(url) {
  try { const r = await toolsService.executeTool('web_scrape', { url }, false, { source: 'finance', bypassIdempotency: true });
    const inner = (r && (r.result || r)) || {};
    return inner.text || inner.content || inner.article || inner.markdown || (inner.result && (inner.result.text || inner.result.content || inner.result.article)) || '';
  } catch { return ''; }
}
async function _findStateUrl(state) {
  try { const r = await toolsService.executeTool('web_search', { query: `${state} Department of Revenue individual income tax official site` }, false, { source: 'finance', bypassIdempotency: true });
    const inner = (r && (r.result || r)) || {};
    const results = inner.results || (inner.result && inner.result.results) || [];
    for (const res of results) { const u = res.url || res.href; if (u && /\.gov(\b|\/|$)/.test(u)) return u; }
    return (results[0] && (results[0].url || results[0].href)) || '';
  } catch { return ''; }
}
const TOPIC_QUERIES = (process.env.AVA_FINANCE_TOPICS
  || 'individual income tax brackets and rates|standard deduction and exemptions|filing requirements deadlines and extensions|sales and use tax rate|business and self-employment tax|tax credits and deductions').split('|');
const LINK_KEYWORDS = /(income|tax|sales|use[- ]?tax|deduction|credit|filing|\bfile\b|rate|bracket|business|self[- ]?employ|withhold|estimate|exempt|return|payment|refund|individual)/i;
const MAX_CRAWL = parseInt(process.env.AVA_FINANCE_MAX_CRAWL || '5', 10);

async function _scrapeRich(url) {
  try {
    const r = await toolsService.executeTool('web_scrape', { url, links: true, max_chars: 8000 }, false, { source: 'finance', bypassIdempotency: true });
    const inner = (r && (r.result || r)) || {};
    const res = inner.result || inner;
    return { text: res.text || res.content || res.article || '', isPortal: !!res.is_portal, links: Array.isArray(res.links) ? res.links : [] };
  } catch { return { text: '', isPortal: false, links: [] }; }
}
async function _findContentUrl(query) {
  try {
    const r = await toolsService.executeTool('web_search', { query: query + ' official site' }, false, { source: 'finance', bypassIdempotency: true });
    const inner = (r && (r.result || r)) || {};
    const results = inner.results || (inner.result && inner.result.results) || [];
    for (const res of results) { const u = res.url || res.href; if (u && /\.gov(\b|\/|$)/.test(u)) return u; }
    return (results[0] && (results[0].url || results[0].href)) || '';
  } catch { return ''; }
}
// Search engines → a ranked list of candidate URLs (prefer .gov), deduped, blacklist filtered.
async function _searchUrls(query, n = 6) {
  try {
    const r = await toolsService.executeTool('web_search', { query }, false, { source: 'finance', bypassIdempotency: true });
    const inner = (r && (r.result || r)) || {};
    const results = inner.results || (inner.result && inner.result.results) || [];
    const seen = new Set(); const gov = []; const rest = [];
    for (const res of results) {
      const u = res.url || res.href;
      if (!u || !/^https?:\/\//.test(u) || seen.has(u)) continue;
      seen.add(u); (/\.gov(\b|\/|$)/.test(u) ? gov : rest).push(u);
    }
    return [...gov, ...rest].slice(0, n);
  } catch { return []; }
}
// Subject phrasings used to hunt for ALTERNATE sources when a source's own URL is dead.
function _subjectQueries(w) {
  if (w.kind === 'state' && w.state) return [
    `${w.state} individual income tax rates filing requirements`,
    `${w.state} department of revenue income tax official site`
  ];
  const base = String(w.source || '').replace(/\s+[—-].*$/, '').trim();
  return [`${base} ${w.topic || 'tax'} IRS official`, `${w.topic || base} federal tax rules`];
}
async function _store(text, source, url, w) {
  try { const o = await ingest({ text, source, url, topic: w.topic, jurisdiction: w.jurisdiction }); return o.stored || 0; } catch { return 0; }
}
// Portal page → crawl its relevant links into real content pages (dead links get blacklisted).
async function _crawlPortal(r, w) {
  let got = 0; const dead = _deadUrls();
  const rel = (r.links || []).filter(l => LINK_KEYWORDS.test((l.text || '') + ' ' + (l.url || ''))).slice(0, MAX_CRAWL);
  for (const l of rel) {
    if (!l.url || dead.has(l.url)) continue;
    const sub = await _scrapeText(l.url);
    if (sub && sub.length >= 200) got += await _store(sub, `${w.source} — ${(l.text || 'page').slice(0, 60)}`, l.url, w);
    else _markDead(l.url);
  }
  return got;
}
// Ingest a source's CONTENT. Prefers a previously-discovered working URL; on failure it searches
// for ALTERNATE sources on the same subject and scrapes them until one succeeds. Returns rich state
// so the populator can persist the working URL, an unchanged-refresh signal, and a content hash.
async function _ingestSource(w, prev = {}) {
  const dead = _deadUrls();
  const primary = prev.workingUrl || w.url;
  let got = 0, contentHash = prev.contentHash || null;

  // 1) try the known-good / primary URL
  if (primary && !dead.has(primary)) {
    const r = await _scrapeRich(primary);
    if (r.text && r.text.length >= 200 && !r.isPortal) {
      const h = _hash(r.text.slice(0, 4000));
      if (prev.ok && h === prev.contentHash) return { got: 0, unchanged: true, workingUrl: prev.workingUrl || null, contentHash: h, altTried: prev.altTried || false };
      got += await _store(r.text, w.source, primary, w); contentHash = h;
    } else if (r.isPortal || (r.text || '').length < 200) {
      got += await _crawlPortal(r, w);
    }
    if (got > 0) return { got, workingUrl: prev.workingUrl || null, contentHash, altTried: prev.altTried || false };
    _markDead(primary);
  }

  // 2) primary yielded nothing → find ALTERNATES via search engines, scrape until success
  let workingUrl = null;
  for (const q of _subjectQueries(w)) {
    const cands = (await _searchUrls(q, ALT_MAX + 2)).filter(u => u !== primary && u !== w.url && !_deadUrls().has(u));
    for (const u of cands.slice(0, ALT_MAX)) {
      const rr = await _scrapeRich(u); let g = 0;
      if (rr.text && rr.text.length >= 200 && !rr.isPortal) { g += await _store(rr.text, `${w.source} (alt)`, u, w); contentHash = _hash(rr.text.slice(0, 4000)); }
      else if (rr.isPortal || (rr.text || '').length < 200) g += await _crawlPortal(rr, w);
      if (g > 0) { got += g; workingUrl = u; break; }
      _markDead(u);
    }
    if (got > 0) break;
  }
  return { got, workingUrl, contentHash, altTried: true };
}
// Topic-driven DEPTH: per jurisdiction, search each topic specifically and ingest the content page.
async function _ingestTopics(jurisdiction, label) {
  let got = 0; const jw = { topic: '', jurisdiction };
  for (const t of TOPIC_QUERIES) {
    // Scrape ALL relevant search results for the topic (not just the first .gov) so coverage is broad.
    const urls = (await _searchUrls(`${label} ${t}`, 3)).filter(u => !_deadUrls().has(u));
    for (const url of urls) {
      const r = await _scrapeRich(url);
      let txt = r.text;
      if ((!txt || txt.length < 200 || r.isPortal) && r.links.length) {
        const rel = r.links.filter(l => LINK_KEYWORDS.test((l.text || '') + ' ' + (l.url || ''))).slice(0, 2);
        for (const l of rel) { const s = await _scrapeText(l.url); if (s && s.length >= 200) { txt = s; break; } }
      }
      if (txt && txt.length >= 200) { const n = await _store(txt, `${label}: ${t}`, url, { ...jw, topic: t.split(' ')[0] }); got += n; if (n > 0) break; }
      else _markDead(url);
    }
  }
  return got;
}

function _workList() {
  let federal = [], states = [];
  try { federal = (JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8')).sources || []).map(s => ({ key: 'fed:' + s.url, kind: 'federal', url: s.url, source: s.source, topic: s.topic, jurisdiction: 'US-federal' })); } catch { /* ignore */ }
  try { states = (JSON.parse(fs.readFileSync(STATES_PATH, 'utf8')).states || []).map(s => ({ key: 'st:' + s.state, kind: 'state', state: s.state, url: s.url, source: `${s.state} — ${s.agency}`, topic: 'state-tax', jurisdiction: 'US-' + s.state })); } catch { /* ignore */ }
  return [...federal, ...states];
}

// mode 'all' = (re)fetch everything; 'auto' = only sources never-succeeded, previously-failed, or stale.
export function runPopulate(opts = {}) {
  if (_pop.running) return { already: true, ..._pop };
  const mode = opts.mode || 'all';
  const deep = mode === 'deep';
  const work = _workList(); const prog = _readProgress(); const now = Date.now();
  const due = work.filter(w => {
    if (mode === 'all' || deep) return !(prog[w.key] && prog[w.key].dead);   // even full re-runs skip abandoned subjects
    const p = prog[w.key];
    if (!p) return true;                 // never tried
    if (p.dead) return false;            // gave up (URL + alternates all dead) — stop retrying
    if (!p.ok) return true;              // keep trying (with alternates) until it's marked dead
    return (now - (Date.parse(p.lastOkAt) || 0)) > REFRESH_DAYS * 86400000;  // success → only refresh when stale
  });
  const jurs = deep ? [...new Set(work.map(w => w.jurisdiction))] : [];
  _pop = { running: true, total: due.length + jurs.length, done: 0, ok: 0, failed: 0, lastSource: '', startedAt: new Date().toISOString(), finishedAt: null, mode };
  if (!due.length && !jurs.length) { _pop.running = false; _pop.finishedAt = new Date().toISOString(); return { started: false, nothingDue: true, mode }; }
  (async () => {
    // 1) each source, content-first (crawls portal links into real content pages)
    for (const w of due) {
      const prev = prog[w.key] || {};
      let res = { got: 0 };
      try { res = await _ingestSource(w, prev); } catch { /* skip */ }
      const got = res.got || 0;
      const ok = got > 0 || res.unchanged === true;      // an unchanged refresh still counts as a success
      const fails = ok ? 0 : (prev.fails || 0) + 1;
      const altTried = prev.altTried || res.altTried || false;
      const dead = !ok && altTried && fails >= MAX_FAILS; // only abandon after alternates were tried
      prog[w.key] = {
        ok: ok || prev.ok || false,
        lastOkAt: ok ? new Date().toISOString() : (prev.lastOkAt || null),
        lastAttemptAt: new Date().toISOString(),
        fails, chunks: (prev.chunks || 0) + got, dead,
        workingUrl: res.workingUrl || prev.workingUrl || null,
        contentHash: res.contentHash || prev.contentHash || null,
        altTried
      };
      _writeProgress(prog);
      _pop.done++; _pop.lastSource = w.source; ok ? _pop.ok++ : _pop.failed++;
    }
    // 2) DEEP fill: topic-specific searches per jurisdiction for real depth
    for (const jur of jurs) {
      const label = jur === 'US-federal' ? 'US federal' : jur.replace(/^US-/, '');
      let got = 0; try { got = await _ingestTopics(jur, label); } catch { /* skip */ }
      const tkey = 'topics:' + jur; const prev = prog[tkey] || {};
      prog[tkey] = { ok: got > 0 || prev.ok || false, lastOkAt: got > 0 ? new Date().toISOString() : (prev.lastOkAt || null), lastAttemptAt: new Date().toISOString(), chunks: (prev.chunks || 0) + got };
      _writeProgress(prog);
      _pop.done++; _pop.lastSource = label + ' (topics)'; got > 0 ? _pop.ok++ : _pop.failed++;
    }
    _pop.running = false; _pop.finishedAt = new Date().toISOString();
    logger.info('[finance-kb] populate complete', { mode, ok: _pop.ok, failed: _pop.failed, total: _pop.total });
  })().catch(e => { _pop.running = false; logger.warn('[finance-kb] populate crashed', { error: e.message }); });
  return { started: true, total: due.length + jurs.length, mode };
}

// Auto-refresh scheduler: frequently fills the misses + keeps the corpus current. Opt-out with
// AVA_FINANCE_AUTOPOPULATE=0. Every AVA_FINANCE_POPULATE_HOURS (default 6h) it retries failed/stale.
if ((process.env.AVA_FINANCE_AUTOPOPULATE || '1') !== '0') {
  const everyMs = Math.max(1, parseInt(process.env.AVA_FINANCE_POPULATE_HOURS || '6', 10)) * 3600000;
  const t = setInterval(() => { try { runPopulate({ mode: 'auto' }); } catch { /* ignore */ } }, everyMs);
  if (t.unref) t.unref();
  const t0 = setTimeout(() => { try { runPopulate({ mode: 'auto' }); } catch { /* ignore */ } }, Math.max(1, parseInt(process.env.AVA_FINANCE_INITIAL_DELAY_MIN || '3', 10)) * 60000);
  if (t0.unref) t0.unref();
}

export default { ingest, search, stats, runPopulate, popStatus };
// scrape-hardening: dead-URL blacklist + alternate discovery + source-level dedup (rev)
