// contextCompression — rolling summary + LINEAGE for long conversations. AVA's transcript is windowed
// (last N turns / chars), so older turns used to be TRUNCATED and lost. Instead, we fold the dropped
// turns into a compact running summary and record each summarization as a lineage GENERATION
// (parent -> child) rather than rewriting history. Mirrors Hermes' lineage-based context compression.
// Persisted to data/lineage.json, keyed by sessionId. Best-effort: any failure leaves behavior unchanged.
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import llmService from './llm.js';
import conversationLogger from './conversationLogger.js';

const FILE = path.join(process.cwd(), 'data', 'lineage.json');
const TURN_TRIGGER = parseInt(process.env.AVA_COMPRESS_EVERY_TURNS || '20', 10); // start compressing past ~N turns
const MIN_NEW = parseInt(process.env.AVA_COMPRESS_MIN_NEW || '8', 10);           // need this many new turns since last gen
const THROTTLE_MS = 60000;
const _lastRun = {};

function _load() { try { if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { /* ignore */ } return {}; }
function _save(m) {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(m, null, 2)); }
  catch (e) { try { logger.warn('[compress] save failed', { error: e.message }); } catch { /* ignore */ } }
}

// Latest rolling summary for a session — injected into the prompt so dropped context isn't lost.
function summaryFor(sessionId) {
  const c = _load()[sessionId || 'default'];
  if (!c || !Array.isArray(c.chain) || !c.chain.length) return '';
  return c.chain[c.chain.length - 1].summary || '';
}
// Full lineage chain for inspection.
function lineage(sessionId) { return _load()[sessionId || 'default'] || { chain: [], coveredCount: 0 }; }

function _sessionTurns(sessionId) {
  let all = [];
  try { all = conversationLogger.getRecentHistoryAcrossDays(400) || []; } catch { all = []; }
  return all.filter((t) => String(t?.metadata?.sessionId || 'default') === String(sessionId));
}

// Compress if the session has grown enough since the last generation. `force` bypasses the
// throttle + the turn-count gate (used for verification), but still needs at least 1 new turn.
async function maybeCompress(sessionId, opts = {}) {
  sessionId = sessionId || 'default';
  const force = !!opts.force;
  try {
    const now = Date.now();
    if (!force && _lastRun[sessionId] && now - _lastRun[sessionId] < THROTTLE_MS) return { skipped: 'throttled' };
    const turns = _sessionTurns(sessionId);
    if (!force && turns.length < TURN_TRIGGER) return { skipped: 'too_short', turns: turns.length };
    const m = _load();
    const cur = m[sessionId] || { chain: [], coveredCount: 0 };
    const newCount = turns.length - (cur.coveredCount || 0);
    if (newCount < (force ? 1 : MIN_NEW)) return { skipped: 'no_new', newCount };
    _lastRun[sessionId] = now;

    const prior = cur.chain.length ? cur.chain[cur.chain.length - 1].summary : '';
    const sinceTurns = turns.slice(cur.coveredCount || 0).map((t) => {
      const who = (t.direction || t.role) === 'assistant' ? 'AVA' : 'You';
      return `${who}: ${String(t.content || '').slice(0, 300)}`;
    }).join('\n').slice(0, 6000);
    if (!sinceTurns.trim()) return { skipped: 'empty' };

    const sys = 'You maintain a COMPACT running summary of a conversation so older turns can be dropped from context without losing meaning. Given the PREVIOUS summary and the NEW turns since, output an updated summary (<= 180 words) capturing durable facts, decisions, open threads, and user preferences. Plain prose, no preamble.';
    const user = `PREVIOUS SUMMARY:\n${prior || '(none yet)'}\n\nNEW TURNS:\n${sinceTurns}`;
    const r = await llmService.chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.3, max_tokens: 400 });
    const summary = String(r.text || r.content || '').trim();
    if (!summary) return { skipped: 'no_summary' };

    const gen = cur.chain.length + 1;
    cur.chain.push({ gen, parent: gen > 1 ? gen - 1 : null, createdAt: new Date().toISOString(), turnsCovered: turns.length, summary });
    if (cur.chain.length > 20) cur.chain = cur.chain.slice(-20);
    cur.coveredCount = turns.length;
    m[sessionId] = cur;
    _save(m);
    logger.info('[compress] new summary generation', { sessionId, gen, turns: turns.length });
    return { ok: true, gen, turnsCovered: turns.length, summary };
  } catch (e) {
    try { logger.warn('[compress] maybeCompress failed', { error: e.message }); } catch { /* ignore */ }
    return { error: e.message };
  }
}

export { summaryFor, lineage, maybeCompress };
export default { summaryFor, lineage, maybeCompress };
