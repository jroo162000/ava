// actionHistory.js — a clean, queryable log of AVA's OWN recent actions on the user's machine
// (files created/edited, windows/apps opened or focused, browser navigations, messages sent,
// screenshots, etc.). Part of her "local OS-integration" upgrade so "what did you just do?" and
// "undo what you just changed" answer from a REAL record, not memory text. Populated from each
// agent turn's tool history; in-memory ring + JSONL persistence.
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const LOG = path.join(DATA_DIR, 'action-history.jsonl');
const RING_MAX = 200;
let _ring = [];
let _loaded = false;

function _ensure() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ } }
function _load() {
  if (_loaded) return; _loaded = true;
  try {
    if (fs.existsSync(LOG)) {
      _ring = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-RING_MAX)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
  } catch { /* ignore */ }
}

// Map a tool call + args into a short, human-readable "what she did" line.
function _summarize(tool, args) {
  const a = args || {}; const t = String(tool || '');
  const pick = (...keys) => { for (const k of keys) { const v = a[k]; if (v != null && String(v).trim()) return String(v).trim(); } return ''; };
  let obj = pick('target', 'path', 'file', 'filename', 'url', 'title', 'app', 'name', 'to', 'query', 'text');
  if (obj) obj = obj.split(/[\\/]/).pop();
  const short = obj ? (obj.length > 90 ? obj.slice(0, 90) + '…' : obj) : '';
  const act = String(a.action || '').toLowerCase();
  const M = {
    open_item: () => 'opened',
    file_gen: () => 'created file',
    fs_ops: () => ({ write: 'wrote', read: 'read', copy: 'copied', move: 'moved', delete: 'deleted', mkdir: 'made folder', list: 'listed files in' }[act] || 'file op'),
    window_ops: () => ({ focus: 'focused window', close: 'closed window', minimize: 'minimized window', maximize: 'maximized window', list: 'listed open windows', move: 'moved window', resize: 'resized window' }[act] || 'window op'),
    browser_automation: () => ({ navigate: 'navigated browser to', click: 'clicked in browser', type: 'typed in browser', launch: 'launched browser' }[act] || 'browser action'),
    comm_ops: () => ({ send_email: 'sent email to', send_sms: 'texted', search_emails: 'searched email for' }[act] || 'comm action'),
    camera_ops: () => 'used the camera',
    screen_ops: () => 'took a screenshot',
    screenshot: () => 'took a screenshot',
    vision_ops: () => 'read the screen',
    ocr_ops: () => 'read text on screen',
    calendar_ops: () => ({ create: 'created calendar event', list: 'checked the calendar', delete: 'deleted calendar event', update: 'updated calendar event' }[act] || 'calendar action'),
    key_ops: () => 'sent keystrokes',
    mouse_ops: () => 'moved/clicked the mouse',
    net_ops: () => 'fetched a web page',
    web_search: () => 'searched the web for',
    sys_ops: () => 'checked system info',
    memory_search: () => 'searched memory for',
  };
  const verb = (M[t] ? M[t]() : t.replace(/_/g, ' '));
  return (verb + (short ? ' ' + short : '')).trim();
}

// Record the successful actions from one completed agent turn.
export function recordTurn(sessionId, state) {
  try {
    _load(); _ensure();
    const hist = (state && state.history) || [];
    const ts = new Date().toISOString();
    const added = [];
    for (const h of hist) {
      const tool = h && h.action && (h.action.tool || h.action.type);
      if (!tool || ['final', 'answer', 'clarify', 'respond'].includes(String(tool))) continue;
      const status = String((h && h.result && h.result.status) || 'ok');
      if (/error|fail|denied|needs_|blocked/i.test(status)) continue;  // only things she actually did
      const summary = _summarize(tool, h.action && h.action.args);
      if (summary) added.push({ ts, sessionId, tool, summary, status });
    }
    if (!added.length) return;
    _ring.push(...added);
    if (_ring.length > RING_MAX) _ring = _ring.slice(-RING_MAX);
    try { for (const a of added) fs.appendFileSync(LOG, JSON.stringify(a) + '\n', 'utf8'); } catch { /* ignore */ }
  } catch (e) { try { logger.warn('[actionHistory] record failed', { error: e.message }); } catch { /* ignore */ } }
}

export function recent(limit = 8) { _load(); return _ring.slice(-Math.max(1, limit)); }

// One-line summary (newest last) for prompt context.
export function summarize(limit = 6) {
  const items = recent(limit);
  return items.length ? items.map(a => a.summary).join('; ') : '';
}

export function pruneByAge(maxAgeMs, minRetain = 3) {
  _load();
  if (!_ring.length) return 0;
  const cutoff = Date.now() - maxAgeMs;
  // Always keep the last minRetain entries regardless of age
  const keep = Math.min(minRetain, _ring.length);
  const alwaysKeep = _ring.slice(-keep);
  const candidates = _ring.slice(0, -keep);
  const lenBefore = _ring.length;
  const pruned = candidates.filter(e => {
    const ts = e && e.ts;
    if (!ts) return true;
    const t = new Date(ts).getTime();
    return !isNaN(t) && t >= cutoff;
  });
  _ring = [...pruned, ...alwaysKeep];
  const removed = lenBefore - _ring.length;
  if (removed > 0) _persist();
  return removed;
}

function _persist() {
  try {
    _ensure();
    fs.writeFileSync(LOG, _ring.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  } catch { /* ignore */ }
}

export function prune() {
  return pruneByAge(24 * 60 * 60 * 1000, 5);
}

export default { recordTurn, recent, summarize, pruneByAge, prune };
