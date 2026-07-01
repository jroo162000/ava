// moltbookWatchlist.js -- a focused list of submolts / handles / topics AVA prioritizes on Moltbook.
// It does NOT restrict her (she still engages broadly); it biases which feed items she engages with
// first, so her attention is focused rather than purely first-come. Managed via /moltbook/watchlist.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WPATH = process.env.AVA_MOLTBOOK_WATCHLIST || path.join(__dirname, '..', '..', '..', 'ava-integration', 'memory', 'moltbook-watchlist.json');

function _load() {
  try { return fs.existsSync(WPATH) ? JSON.parse(fs.readFileSync(WPATH, 'utf8')) : []; } catch { return []; }
}
function _save(list) {
  try { fs.mkdirSync(path.dirname(WPATH), { recursive: true }); fs.writeFileSync(WPATH, JSON.stringify(list, null, 2)); }
  catch (e) { logger.warn('[moltbook-watchlist] save failed', { error: e.message }); }
}

export function list() { return _load(); }

export function add(term, kind = 'topic') {
  const t = String(term || '').trim().toLowerCase().slice(0, 80);
  if (!t) return null;
  const l = _load();
  if (l.find(x => x.term === t)) return l.find(x => x.term === t);
  const entry = { term: t, kind: ['topic', 'submolt', 'handle'].includes(kind) ? kind : 'topic', addedAt: new Date().toISOString() };
  l.push(entry); _save(l.slice(-100));
  logger.info('[moltbook-watchlist] added', { term: t, kind: entry.kind });
  return entry;
}

export function remove(term) {
  const t = String(term || '').trim().toLowerCase();
  const l = _load();
  const next = l.filter(x => x.term !== t);
  if (next.length !== l.length) { _save(next); return true; }
  return false;
}

// How strongly a piece of feed text matches the watchlist (count of distinct terms present).
// Used to sort engagement candidates so watched topics/handles/submolts get her attention first.
export function score(text) {
  const hay = String(text || '').toLowerCase();
  if (!hay) return 0;
  let s = 0;
  for (const { term } of _load()) { if (term && hay.includes(term)) s += 1; }
  return s;
}

// Compact block for her context so she knows what she's chosen to keep an eye on.
export function block() {
  const l = _load();
  if (!l.length) return '';
  return `[MOLTBOOK WATCHLIST -- topics/handles you're keeping an eye on and prioritizing: ${l.map(x => x.term).slice(0, 20).join(', ')}]`;
}

export default { list, add, remove, score, block };
