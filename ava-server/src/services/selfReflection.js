// selfReflection.js — AVA's autonomous metacognitive loop.
//
// Subscribes to the REAL event bus (voiceBus, via onVoiceEvent) and, on each assistant turn
// (event.type === 'assistant.final', source 'conversation'), buffers the last 8 assistant turns,
// extracts self-reflective sentences, distills them to <=3 concise reflections, and appends them to
// logs/selfReflections.jsonl. Everything here uses only proven APIs: onVoiceEvent + fs.
//
// (History: an earlier self-proposed version was rejected because it assumed conversationLogger was
// an EventEmitter with a 'conversation' event. It is NOT — conversationLogger.logMessage() calls
// emitVoiceEvent('assistant.final', {text}, 'conversation'), where 'conversation' is the SOURCE tag
// and the real subscription hook is voiceBus.onVoiceEvent. This version uses that real hook.)
import { onVoiceEvent } from './voiceBus.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', '..', 'logs', 'selfReflections.jsonl');
const CURSOR = path.join(__dirname, '..', '..', 'logs', 'selfReflections.cursor');
const MAX_TURNS = 8;
const MAX_REFLECTIONS = 3;

// Genuine metacognition markers — deliberately NARROW so ordinary "I'll help you with that" chatter
// is ignored and only real self-correction/learning is captured.
const REFLECTIVE = /\b(i (should(n'?t)? have|could have|realized?|noticed|was wrong|got (that|it) wrong|misjudged|misread|misunderstood|assumed|overlooked|jumped the gun|didn'?t (actually|really)|failed to)|next time i|my mistake|in hindsight|on reflection|lesson (here|learned)|i'?ve learned|to be fair,? i)\b/i;

/** Pure: pull distinct self-reflective sentences out of a set of turns, most-recent <= max. */
export function extractReflections(turns, max = MAX_REFLECTIONS) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(turns) ? turns : []) {
    for (const raw of String(t || '').split(/(?<=[.!?…])\s+/)) {
      const s = raw.trim();
      if (s.length < 12 || !REFLECTIVE.test(s)) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out.slice(-max);
}

const _state = { buffer: [], lastKey: '' };

function _appendFile(entry) {
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.appendFileSync(OUT, JSON.stringify(entry) + '\n');
  } catch { /* never break on telemetry */ }
}

/**
 * Ingest ONE assistant turn: buffer it (last MAX_TURNS), distill reflections, and persist only when
 * a NEW reflection set appears (no duplicate spam). Returns the persisted entry or null.
 * `writer` is injectable for tests; defaults to the jsonl append.
 */
export function _ingest(text, writer = _appendFile) {
  const t = String(text || '').trim();
  if (!t) return null;
  _state.buffer.push(t);
  while (_state.buffer.length > MAX_TURNS) _state.buffer.shift();
  const reflections = extractReflections(_state.buffer);
  if (!reflections.length) return null;
  const key = reflections.join(' || ').toLowerCase();
  if (key === _state.lastKey) return null;
  _state.lastKey = key;
  const entry = { ts: Date.now(), turns: _state.buffer.length, reflections };
  try { writer(entry); } catch { /* resilient */ }
  return entry;
}

let _started = false;
/** Attach the listener to the live bus. Idempotent. Called once at server boot. */
export function start() {
  if (_started) return false;
  _started = true;
  onVoiceEvent((event) => {
    try {
      if (!event || event.type !== 'assistant.final' || event.source !== 'conversation') return;
      _ingest(event.data && event.data.text);
    } catch { /* resilient — telemetry must never crash the bus */ }
  });
  // Phase 2: periodically fold new reflections into durable memory (closes the loop). Timers are
  // unref'd so they never keep the process alive; interval is env-tunable (AVA_REFLECTION_FOLD_MS).
  const foldMs = parseInt(process.env.AVA_REFLECTION_FOLD_MS || String(30 * 60 * 1000), 10) || (30 * 60 * 1000);
  try { const t0 = setTimeout(() => { foldIntoMemory().catch(() => {}); }, 60 * 1000); if (t0.unref) t0.unref(); } catch { /* optional */ }
  try { const t1 = setInterval(() => { foldIntoMemory().catch(() => {}); }, foldMs); if (t1.unref) t1.unref(); } catch { /* optional */ }
  return true;
}

/** Read back recent reflections (for a future consumer that folds them into memory/persona). */
export function recent(n = 20) {
  try {
    const lines = fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ─── Phase 2: the CONSUMER — fold reflections into durable memory ────────────────────────────────
// Capture alone isn't self-improving; this reads NEW reflections (past a persisted line cursor),
// distills distinct lessons, and upserts them as durable WARNING-type memories. memoryHub.search()
// then injects them back into future prompts, so past mistakes actually shape later replies.

function _readCursor() { try { return parseInt(String(fs.readFileSync(CURSOR, 'utf8')).trim(), 10) || 0; } catch { return 0; } }
function _writeCursor(n) { try { fs.mkdirSync(path.dirname(CURSOR), { recursive: true }); fs.writeFileSync(CURSOR, String(n)); } catch { /* best-effort */ } }

/** Pure: given the raw jsonl lines and a start cursor, return { lessons, total } (distinct, trimmed). */
export function _lessonsFromLines(lines, cursor = 0) {
  const all = Array.isArray(lines) ? lines.filter((l) => String(l || '').trim()) : [];
  const fresh = all.slice(Math.max(0, cursor));
  const seen = new Set();
  const lessons = [];
  for (const line of fresh) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    for (const r of (entry && Array.isArray(entry.reflections) ? entry.reflections : [])) {
      const s = String(r || '').trim();
      const k = s.toLowerCase();
      if (s.length < 12 || seen.has(k)) continue;
      seen.add(k);
      lessons.push(s);
    }
  }
  return { lessons, total: all.length };
}

/**
 * Fold new reflections into durable memory. Idempotent via the line cursor + memoryHub's own upsert
 * dedupe. Returns { processed, stored }. All IO is injectable so it can be unit-tested with no disk
 * or DB. Best-effort: a memory write that fails never throws.
 */
export async function foldIntoMemory({
  upsert = null,
  readAll = () => { try { return fs.readFileSync(OUT, 'utf8'); } catch { return ''; } },
  getCursor = _readCursor,
  setCursor = _writeCursor,
  maxPerRun = 10,
} = {}) {
  // Lazy-load memoryHub only when actually folding (keeps the listener module free of the memory DB
  // at import time). Tests inject `upsert` and never touch the real store.
  let memType = 'warning';
  if (!upsert) {
    try {
      const mod = await import('./memoryHub.js');
      upsert = mod.default.upsert;
      memType = (mod.MemoryType && mod.MemoryType.WARNING) || 'warning';
    } catch { return { processed: 0, stored: 0 }; }
  }
  const lines = String(readAll() || '').split('\n');
  const nonEmpty = lines.filter((l) => l.trim());
  const cursor = getCursor();
  if (nonEmpty.length <= cursor) return { processed: 0, stored: 0 };
  const { lessons } = _lessonsFromLines(nonEmpty, cursor);
  let stored = 0;
  for (const lesson of lessons.slice(0, maxPerRun)) {
    try {
      await upsert({
        text: lesson,
        type: memType,                      // "a lesson from a past mistake" (MemoryType.WARNING)
        priority: 4,                        // high-ish so it surfaces in retrieval
        source: 'self-reflection',
        tags: ['self-reflection', 'lesson'],
        role: 'assistant',
      });
      stored++;
    } catch { /* one bad write must not abort the batch */ }
  }
  setCursor(nonEmpty.length);              // advance past everything we just read
  return { processed: nonEmpty.length - cursor, stored };
}

/** Test-only: reset internal state. */
export function _reset() { _state.buffer.length = 0; _state.lastKey = ''; _started = false; }

export const _internal = { OUT, MAX_TURNS, MAX_REFLECTIONS, state: _state };
export default { start, recent, extractReflections };
