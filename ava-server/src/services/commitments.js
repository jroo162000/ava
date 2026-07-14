// commitments.js — AVA's accountability tracker. She logs things Jelani (or she) commits to,
// surfaces the open ones in her context so she can proactively remind, and marks them done.
// She flagged wanting accountability "more explicit" — this makes it explicit and persistent.
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { pushAnnouncement } from './announceQueue.js';
import { emitVoiceEvent } from './voiceBus.js';

const CPATH = path.join(process.env.AVA_INTEGRATION_DIR || path.resolve('./data'), 'commitments.json');
const CHECK_INTERVAL_MS = Number(process.env.AVA_COMMITMENT_CHECK_INTERVAL_MS) || 3600000;
let _lastCheck = 0;
let _checkTimer = null;

function _load() { try { return fs.existsSync(CPATH) ? JSON.parse(fs.readFileSync(CPATH, 'utf8')) : []; } catch { return []; } }
function _save(list) { try { fs.mkdirSync(path.dirname(CPATH), { recursive: true }); fs.writeFileSync(CPATH, JSON.stringify(list, null, 2)); } catch (e) { logger.warn('[commitments] save failed', { error: e.message }); } }

export function storeCommitment(content, source = 'user', deadline = null) {
  return add(content, { who: source, due: deadline });
}

export function getPendingCommitments() {
  const list = _load();
  const now = Date.now();
  return list.filter(c => {
    const due = c.due || c.deadline;
    return !c.done && !c.breached && (!due || new Date(due).getTime() > now);
  });
}

export function checkDeadlines() {
  const list = _load();
  const now = Date.now();
  const warnings = [];
  for (const c of list) {
    const due = c.due || c.deadline;
    if (c.done || c.breached || !due) continue;
    const deadlineMs = new Date(due).getTime();
    if (!Number.isFinite(deadlineMs)) continue;
    const diff = deadlineMs - now;
    if (diff <= 0) {
      c.breached = true;
      c.breachedAt = new Date().toISOString();
      warnings.push(c);
      pushAnnouncement(`A commitment is overdue: ${c.text}`);
      emitVoiceEvent('commitment.deadline', { ...c, state: 'overdue' }, 'commitments');
      logger.warn('[commitments] deadline passed', { id: c.id, text: c.text.slice(0, 60), deadline: due });
    } else if (diff <= CHECK_INTERVAL_MS && diff > 0) {
      const lastNotice = c.approachingAnnouncedAt ? new Date(c.approachingAnnouncedAt).getTime() : 0;
      if (lastNotice && now - lastNotice <= CHECK_INTERVAL_MS) continue;
      c.approachingAnnouncedAt = new Date().toISOString();
      warnings.push({ ...c, _approaching: true });
      pushAnnouncement(`A commitment is coming due: ${c.text}`);
      emitVoiceEvent('commitment.deadline', { ...c, state: 'approaching', remainingMs: diff }, 'commitments');
      logger.info('[commitments] deadline approaching', { id: c.id, text: c.text.slice(0, 60), deadline: due, remainingMs: diff });
    }
  }
  if (warnings.length) _save(list);
  return warnings;
}

export function startDeadlineChecker() {
  if (_checkTimer) return;
  _checkTimer = setInterval(() => {
    const now = Date.now();
    if (now - _lastCheck < 60000) return;
    _lastCheck = now;
    checkDeadlines();
  }, Math.min(CHECK_INTERVAL_MS, 60000));
  _lastCheck = Date.now();
  checkDeadlines();
  logger.info('[commitments] deadline checker started', { intervalMs: CHECK_INTERVAL_MS });
}

export function stopDeadlineChecker() {
  if (_checkTimer) { clearInterval(_checkTimer); _checkTimer = null; }
  logger.info('[commitments] deadline checker stopped');
}

export function add(text, opts = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!clean) return null;
  const list = _load();
  const due = opts.due || opts.deadline || null;
  const existing = list.find(c => !c.done && c.text.toLowerCase() === clean.toLowerCase());
  if (existing) {
    if (due && !existing.due) existing.due = due;
    _save(list);
    return existing;
  }
  const c = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: clean, who: opts.who || opts.source || 'user', due, createdAt: new Date().toISOString(), breached: false, done: false };
  list.push(c);
  _save(list.slice(-500));
  logger.info('[commitments] added', { text: clean.slice(0, 60) });
  return c;
}
export function list(openOnly = true) { const l = _load(); return openOnly ? l.filter(c => !c.done) : l; }
export function complete(idOrText) {
  const l = _load();
  const q = String(idOrText || '').toLowerCase();
  const c = l.find(x => !x.done && (x.id === idOrText || x.text.toLowerCase().includes(q)));
  if (c) { c.done = true; c.doneAt = new Date().toISOString(); _save(l); }
  return c || null;
}
// Compact block of open commitments for injecting into her context so she can remind proactively.
export function block() {
  const open = list(true).slice(-8);
  if (!open.length) return '';
  const user = process.env.AVA_USER_NAME || 'the user';
  return `[OPEN COMMITMENTS you're tracking — if one is due or slipping, remind ${user} the way a reliable colleague would (gentle first). Mark it done when it's handled.]\n`
    + open.map(c => `- ${c.text}${c.due ? ' (by ' + c.due + ')' : ''}`).join('\n');
}
export default { add, list, complete, block, storeCommitment, getPendingCommitments, checkDeadlines, startDeadlineChecker, stopDeadlineChecker };
