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
const REFRESH_DAYS = parseInt(process.env.AVA_FINANCE_REFRESH_DAYS || '14', 10);

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
  idx = idx.filter(e => !_isBoilerplate(e.text));   // purge boilerplate already in the KB
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
  const keys = Object.keys(prog);
  const succeeded = keys.filter(k => prog[k] && prog[k].ok).length;
  return { ..._pop, kbChunks: _load().length, sourcesTracked: keys.length, sourcesSucceeded: succeeded };
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
// Ingest a source's CONTENT. If the page is a PORTAL, crawl its relevant links into content pages.
async function _ingestSource(w) {
  let got = 0;
  const r = await _scrapeRich(w.url);
  if (r.text && r.text.length >= 200 && !r.isPortal) {
    try { const o = await ingest({ text: r.text, source: w.source, url: w.url, topic: w.topic, jurisdiction: w.jurisdiction }); got += o.stored || 0; } catch { /* skip */ }
  }
  if (r.isPortal || r.text.length < 200) {
    const rel = (r.links || []).filter(l => LINK_KEYWORDS.test((l.text || '') + ' ' + (l.url || ''))).slice(0, MAX_CRAWL);
    for (const l of rel) {
      const sub = await _scrapeText(l.url);
      if (sub && sub.length >= 200) { try { const o = await ingest({ text: sub, source: `${w.source} — ${(l.text || 'page').slice(0, 60)}`, url: l.url, topic: w.topic, jurisdiction: w.jurisdiction }); got += o.stored || 0; } catch { /* skip */ } }
    }
  }
  return got;
}
// Topic-driven DEPTH: per jurisdiction, search each topic specifically and ingest the content page.
async function _ingestTopics(jurisdiction, label) {
  let got = 0;
  for (const t of TOPIC_QUERIES) {
    const url = await _findContentUrl(`${label} ${t}`);
    if (!url) continue;
    const r = await _scrapeRich(url);
    let txt = r.text;
    if ((!txt || txt.length < 200 || r.isPortal) && r.links.length) {
      const rel = r.links.filter(l => LINK_KEYWORDS.test((l.text || '') + ' ' + (l.url || ''))).slice(0, 2);
      for (const l of rel) { const s = await _scrapeText(l.url); if (s && s.length >= 200) { txt = s; break; } }
    }
    if (txt && txt.length >= 200) { try { const o = await ingest({ text: txt, source: `${label}: ${t}`, url, topic: t.split(' ')[0], jurisdiction }); got += o.stored || 0; } catch { /* skip */ } }
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
    if (mode === 'all' || deep) return true;
    const p = prog[w.key];
    if (!p || !p.ok) return true;
    return (now - (Date.parse(p.lastOkAt) || 0)) > REFRESH_DAYS * 86400000;
  });
  const jurs = deep ? [...new Set(work.map(w => w.jurisdiction))] : [];
  _pop = { running: true, total: due.length + jurs.length, done: 0, ok: 0, failed: 0, lastSource: '', startedAt: new Date().toISOString(), finishedAt: null, mode };
  if (!due.length && !jurs.length) { _pop.running = false; _pop.finishedAt = new Date().toISOString(); return { started: false, nothingDue: true, mode }; }
  (async () => {
    // 1) each source, content-first (crawls portal links into real content pages)
    for (const w of due) {
      let got = 0;
      try { got = await _ingestSource(w); } catch { /* skip */ }
      const ok = got > 0;
      const prev = prog[w.key] || {};
      prog[w.key] = { ok: ok || prev.ok || false, lastOkAt: ok ? new Date().toISOString() : (prev.lastOkAt || null), lastAttemptAt: new Date().toISOString(), fails: ok ? 0 : (prev.fails || 0) + 1, chunks: (prev.chunks || 0) + got };
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
