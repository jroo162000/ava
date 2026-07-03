// artifactBus.js -- the stateful VISUAL PANEL behind AVA's presenting. She opens cards (news,
// photos, video, diagrams, tables, notes), lays them out (spread by default so several are visible
// at once, or stacked if she wants), brings the referenced one to the FRONT / highlights it while
// she talks, moves them in real time, and closes them when done. The UI polls /panel/state and
// mirrors this exactly. She is made aware of the panel via block() so she narrates to what's shown.
import { emitVoiceEvent } from './voiceBus.js';
import logger from '../utils/logger.js';

const MAX = 12;
let _cards = [];
let _focusedId = null;
let _layout = 'spread'; // 'spread' (all visible, highlight the referenced one) | 'stack' (fanned)
let _seq = 0;

function _emit() { try { emitVoiceEvent('panel', { cards: _cards, focusedId: _focusedId, layout: _layout }, 'server'); } catch { /* best-effort */ } }

// type: 'news' | 'image' | 'video' | 'web' | 'mermaid' | 'markdown' | 'table' | 'note' | 'text'
export function open({ type = 'markdown', title = '', content = '', meta = {} } = {}) {
  // Dedup live previews (2026-07-03): the agentLoop preview_url auto-present hook AND the
  // presenter can both open a 'web' card for the SAME URL in one turn — the panel showed twin
  // "localhost:10580" cards. A second web card with identical content just focuses the first.
  if (String(type) === 'web') {
    const _ex = _cards.find((c) => c.type === 'web' && String(c.content) === String(typeof content === 'string' ? content : JSON.stringify(content)));
    if (_ex) { _focusedId = _ex.id; _emit(); return _ex; }
  }
  const id = 'c' + (++_seq) + Date.now().toString(36).slice(-3);
  const card = {
    id, type: String(type || 'markdown'), title: String(title || '').slice(0, 200),
    content: typeof content === 'string' ? content : JSON.stringify(content),
    meta: (meta && typeof meta === 'object') ? meta : {}, ts: Date.now()
  };
  _cards.push(card);
  if (_cards.length > MAX) _cards = _cards.slice(-MAX);
  _focusedId = id;
  _emit();
  logger.info('[panel] open', { type: card.type, title: card.title.slice(0, 60), cards: _cards.length, layout: _layout });
  return card;
}
export function focus(id) { if (_cards.find((c) => c.id === id)) { _focusedId = id; _emit(); return true; } return false; }
export function close(id) {
  const n = _cards.length; _cards = _cards.filter((c) => c.id !== id);
  if (_cards.length !== n) { if (_focusedId === id) _focusedId = _cards.length ? _cards[_cards.length - 1].id : null; _emit(); return true; }
  return false;
}
export function clear() { _cards = []; _focusedId = null; _emit(); }
export function setLayout(mode) { _layout = (mode === 'stack') ? 'stack' : 'spread'; _emit(); return _layout; }
// Move a card to a normalized position (x,y in 0..1 of the panel area) for real-time arranging.
export function move(id, x, y) {
  const c = _cards.find((k) => k.id === id);
  if (!c) return false;
  c.meta = c.meta || {};
  c.meta.pos = { x: Math.max(0, Math.min(1, Number(x))), y: Math.max(0, Math.min(1, Number(y))) };
  _emit(); return true;
}
export function state() { return { cards: _cards, focusedId: _focusedId, layout: _layout }; }

export function block() {
  if (!_cards.length) return '';
  const lines = _cards.map((c, i) => `- #${i + 1} ${c.type}: ${c.title || '(untitled)'}${c.id === _focusedId ? '  <= HIGHLIGHTED' : ''}  [id ${c.id}]`);
  return `[ON SCREEN NOW (${_layout} layout) - your visual panel. You control it with the panel tool. As you talk, HIGHLIGHT the card you're referencing (panel focus) and speak to it; you can spread cards out or stack them (panel layout), move one (panel move), and CLOSE a card (panel close) once you're done with it. Keep it to what's actually relevant.]\n${lines.join('\n')}`;
}

// Back-compat
export function push(a) { return open(a); }
export function recent() { return _cards; }
export function since() { return _cards; }

export default { open, focus, close, clear, setLayout, move, state, block, push, recent, since };
