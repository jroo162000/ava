// Self-reflection routing.
// AVA constantly thinks out loud about her OWN design, limits, and wants (especially on Moltbook),
// and that signal used to go nowhere. This captures those first-person observations from her
// generated output and routes them two ways:
//   1) into her improvement PROPOSER (selfImprove pulls actionable() into its signals), and
//   2) into her conversation context as candidates she MAY raise with Jelani herself, unprompted,
//      when her persona feels like sharing (the LLM/persona decides the "when" — not a fixed trigger).
// No digest file — she brings these up herself; they don't pile up in a document.
// Heuristic capture — better to over-collect a little than to lose the good stuff.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STORE = path.join(DATA_DIR, 'self-reflections.jsonl');
const SHARED = path.join(DATA_DIR, 'self-reflections-shared.json');
const MAX = 600;

const FIRST_PERSON = /\b(i|i'm|i'd|i've|my|myself|me)\b/i;
const SELF_META = /\b(memory|remember|forget|forgetting|prune|retention|schema|design|architecture|pipeline|curiosity supervisor|transparency|consent|limitation|constraint|wish|should|struggle|chewing on|examine|examined|trade-?off|my code|my own|how i (work|think|store|decide|remember)|the way i)\b/i;
const WANT = /\b(i wish|i'd (want|like|prefer|rather)|i should|i need to|i want to|i'm still (working|figuring)|i didn't (examine|realize|look)|closer to .* than i'd like|half the time i|i keep (circling|coming back))\b/i;

function splitSentences(text) {
  return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}
function isReflective(s) {
  if (s.length < 40 || s.length > 600) return false;
  if (!FIRST_PERSON.test(s)) return false;
  return WANT.test(s) || SELF_META.test(s);
}
function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90); }

let _cache = null;
function load() {
  if (_cache) return _cache;
  try {
    _cache = fs.existsSync(STORE)
      ? fs.readFileSync(STORE, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      : [];
  } catch { _cache = []; }
  return _cache;
}
function loadShared() {
  try { return new Set(fs.existsSync(SHARED) ? JSON.parse(fs.readFileSync(SHARED, 'utf8')) : []); }
  catch { return new Set(); }
}

export function captureFrom(text, source = 'unknown') {
  try {
    const sentences = splitSentences(text).filter(isReflective);
    if (!sentences.length) return 0;
    const store = load();
    const seen = new Set(store.map(r => r.key));
    const at = new Date().toISOString();
    let added = 0;
    for (const s of sentences) {
      const key = norm(s);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const rec = { key, text: s, source, actionable: WANT.test(s), at };
      store.push(rec);
      try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(STORE, JSON.stringify(rec) + '\n'); } catch { /* ignore */ }
      added++;
    }
    if (added) { _cache = store.slice(-MAX); logger.info('[self-reflect] captured reflections', { added, source }); }
    return added;
  } catch (e) { logger.warn('[self-reflect] capture failed', { error: e.message }); return 0; }
}

// For the PROPOSER: the things she's said she'd want/change.
export function actionable(n = 12) { return load().filter(r => r.actionable).slice(-n).reverse(); }
export function recent(n = 12) { return load().slice(-n).reverse(); }

// For PROACTIVE SHARING: recent reflections she hasn't raised with Jelani yet (actionable first).
export function forShare(n = 3) {
  const shared = loadShared();
  const unshared = load().filter(r => !shared.has(r.key));
  const acts = unshared.filter(r => r.actionable).slice(-n).reverse();   // her real "wants", newest first
  const rest = unshared.filter(r => !r.actionable).slice(-n).reverse();
  return [...acts, ...rest].slice(0, n).map(r => ({ key: r.key, text: r.text, source: r.source }));
}

// Mark reflections as already surfaced so she doesn't keep raising the same ones.
export function markShared(keys) {
  try {
    const set = loadShared();
    for (const k of (Array.isArray(keys) ? keys : [keys])) if (k) set.add(k);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SHARED, JSON.stringify([...set].slice(-2000)));
  } catch (e) { logger.warn('[self-reflect] markShared failed', { error: e.message }); }
}

export default { captureFrom, actionable, recent, forShare, markShared };
