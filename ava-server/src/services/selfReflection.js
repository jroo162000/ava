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
  return true;
}

/** Read back recent reflections (for a future consumer that folds them into memory/persona). */
export function recent(n = 20) {
  try {
    const lines = fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Test-only: reset internal state. */
export function _reset() { _state.buffer.length = 0; _state.lastKey = ''; _started = false; }

export const _internal = { OUT, MAX_TURNS, MAX_REFLECTIONS, state: _state };
export default { start, recent, extractReflections };
