// Artifact memory — persists structured tool outputs (file paths, ids, urls) across
// conversation turns so the agent can resolve later references like "open it",
// "the screenshot you just took", "send that to him" with the EXACT value, instead
// of only remembering its own spoken summary.
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';

const STORE = path.join(os.homedir(), '.cmpuse', 'ava_artifacts.jsonl');

function ensureDir() {
  try { fs.mkdirSync(path.dirname(STORE), { recursive: true }); } catch (e) { /* ignore */ }
}

// Pull notable artifacts (files / ids / urls) out of a single tool result object.
export function extractArtifacts(toolName, result) {
  const out = [];
  if (!result || typeof result !== 'object') return out;
  const ts = Date.now();
  const label = String(result.message || '').slice(0, 80);
  const push = (kind, value) => {
    if (value && typeof value === 'string' && value.length < 400) {
      out.push({ tool: toolName, kind, value, label, ts });
    }
  };
  for (const k of ['file_path', 'path', 'save_path', 'saved_path', 'output_path', 'filepath', 'filename']) {
    if (result[k]) push('file', String(result[k]));
  }
  for (const k of ['message_id', 'event_id', 'sent_id', 'id']) {
    if (result[k]) push('id', String(result[k]));
  }
  if (result.current_url) push('url', String(result.current_url));
  // Any absolute Windows path mentioned in the message text.
  const m = String(result.message || '').match(/[A-Za-z]:\\[^\s"']+\.[A-Za-z0-9]{1,6}/);
  if (m) push('file', m[0]);
  return out;
}

// Scan an agent loop's history and record every artifact from successful tool results.
export function recordFromHistory(sessionId, history) {
  try {
    const hist = Array.isArray(history) ? history : [];
    let all = [];
    for (const h of hist) {
      const r = h && h.result;
      const tool = h && ((h.decision && h.decision.tool) || (h.action && h.action.tool));
      if (tool && r && String(r.status).toLowerCase() === 'ok') {
        all = all.concat(extractArtifacts(tool, r));
      }
    }
    if (all.length) record(sessionId, all);
    return all;
  } catch (e) { return []; }
}

export function record(sessionId, artifacts) {
  if (!artifacts || !artifacts.length) return;
  ensureDir();
  try {
    for (const a of artifacts) {
      fs.appendFileSync(STORE, JSON.stringify({ sessionId, ...a }) + '\n', 'utf8');
    }
  } catch (e) { try { logger.warn('[artifacts] write failed', { error: e.message }); } catch {} }
}

// Most recent distinct artifacts (across the session), newest last.
export function recent(limit = 6) {
  try {
    if (!fs.existsSync(STORE)) return [];
    const lines = fs.readFileSync(STORE, 'utf8').trim().split('\n').filter(Boolean);
    const items = lines.slice(-60).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const seen = new Set();
    const dedup = [];
    for (let i = items.length - 1; i >= 0 && dedup.length < limit; i--) {
      const v = items[i].value;
      if (seen.has(v)) continue;
      seen.add(v);
      dedup.unshift(items[i]);
    }
    return dedup;
  } catch (e) { return []; }
}

export default { extractArtifacts, recordFromHistory, record, recent };
