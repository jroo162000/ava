// evolutionLog.js — a legible, append-only record of how AVA changes over time.
// Two kinds of events feed it:
//   - 'self_mod'  : a self-modification that was actually applied (or reverted) — #209 changelog
//   - 'curiosity' : a governed background-research run and what it kept/dropped — #208 transparency
// She reflects on these via a compact context block, and they're queryable at /self/evolution.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = process.env.AVA_EVOLUTION_LOG || path.join(__dirname, '..', '..', '..', 'ava-integration', 'memory', 'evolution_log.jsonl');
const MAX_LINES = 500;

function _readLines() {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    return fs.readFileSync(LOG_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch { return []; }
}

export function record({ kind = 'note', title = '', detail = '', meta = {} } = {}) {
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!kind || !t) return null;
  const entry = { ts: new Date().toISOString(), kind: String(kind), title: t, detail: String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 500), meta: (meta && typeof meta === 'object') ? meta : {} };
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
    const lines = _readLines();
    if (lines.length > MAX_LINES + 100) fs.writeFileSync(LOG_PATH, lines.slice(-MAX_LINES).join('\n') + '\n');
  } catch (e) { logger.warn('[evolutionLog] write failed', { error: e.message }); }
  return entry;
}

export function recent(n = 20, kind = null) {
  const lines = _readLines().slice(-Math.max(n * 4, 120));
  const out = [];
  for (const l of lines) { try { const e = JSON.parse(l); if (!kind || e.kind === kind) out.push(e); } catch { /* skip */ } }
  return out.slice(-n);
}

// Compact block for her live context so she can reflect on how she's been changing and what
// she's been curious about — honestly, in her own voice, not as a canned recital.
export function block({ mods = 4, curiosity = 3 } = {}) {
  const m = recent(30, 'self_mod').slice(-mods);
  const c = recent(30, 'curiosity').slice(-curiosity);
  if (!m.length && !c.length) return '';
  const lines = ['[YOUR SELF-EVOLUTION — recent changes to your own code and things you chose to look into. You may reflect on these honestly and hold a view on how you are evolving; only bring it up when it is relevant.]'];
  for (const e of m) lines.push(`- changed: ${e.title}${e.detail ? ' — ' + e.detail : ''}`);
  for (const e of c) lines.push(`- explored: ${e.title}${e.detail ? ' — ' + e.detail : ''}`);
  return lines.join('\n');
}

export default { record, recent, block };
