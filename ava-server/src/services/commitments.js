// commitments.js — AVA's accountability tracker. She logs things Jelani (or she) commits to,
// surfaces the open ones in her context so she can proactively remind, and marks them done.
// She flagged wanting accountability "more explicit" — this makes it explicit and persistent.
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

const CPATH = path.join(process.cwd(), 'data', 'commitments.json');

function _load() { try { return fs.existsSync(CPATH) ? JSON.parse(fs.readFileSync(CPATH, 'utf8')) : []; } catch { return []; } }
function _save(list) { try { fs.mkdirSync(path.dirname(CPATH), { recursive: true }); fs.writeFileSync(CPATH, JSON.stringify(list, null, 2)); } catch (e) { logger.warn('[commitments] save failed', { error: e.message }); } }

export function add(text, opts = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!clean) return null;
  const list = _load();
  const c = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: clean, who: opts.who || 'user', due: opts.due || null, createdAt: new Date().toISOString(), done: false };
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
export default { add, list, complete, block };
