// artifactBus.js -- the stateful VISUAL PANEL behind AVA's presenting. She opens cards (news,
// photos, video, diagrams, tables, notes), brings the relevant one to the FRONT while she talks
// about it, and closes it when done. The UI polls /panel/state and mirrors this exactly. She is
// made aware of the current panel via block() so she narrates to what's on screen.
import { emitVoiceEvent } from './voiceBus.js';
import logger from '../utils/logger.js';

const MAX = 12; // max simultaneous cards
let _cards = [];
let _focusedId = null;
let _seq = 0;

function _emit() { try { emitVoiceEvent('panel', { cards: _cards, focusedId: _focusedId }, 'server'); } catch { /* WS best-effort */ } }

// type: 'news' | 'image' | 'video' | 'web' | 'mermaid' | 'markdown' | 'table' | 'note' | 'text'
// For 'news' content may be JSON [{title,source,url,image,snippet}]. For 'video' content is a
// YouTube url/id or a direct video url. For 'image' content is an image url. For 'web' a page url.
export function open({ type = 'markdown', title = '', content = '', meta = {} } = {}) {
  const id = 'c' + (++_seq) + Date.now().toString(36).slice(-3);
  const card = {
    id,
    type: String(type || 'markdown'),
    title: String(title || '').slice(0, 200),
    content: typeof content === 'string' ? content : JSON.stringify(content),
    meta: (meta && typeof meta === 'object') ? meta : {},
    ts: Date.now()
  };
  _cards.push(card);
  if (_cards.length > MAX) _cards = _cards.slice(-MAX);
  _focusedId = id; // a freshly opened card comes to the front
  _emit();
  logger.info('[panel] open', { type: card.type, title: card.title.slice(0, 60), cards: _cards.length });
  return card;
}
export function focus(id) { if (_cards.find((c) => c.id === id)) { _focusedId = id; _emit(); return true; } return false; }
export function close(id) {
  const n = _cards.length;
  _cards = _cards.filter((c) => c.id !== id);
  if (_cards.length !== n) { if (_focusedId === id) _focusedId = _cards.length ? _cards[_cards.length - 1].id : null; _emit(); return true; }
  return false;
}
export function clear() { _cards = []; _focusedId = null; _emit(); }
export function state() { return { cards: _cards, focusedId: _focusedId }; }

// Awareness block injected into her context so she knows what's on screen and presents to it.
export function block() {
  if (!_cards.length) return '';
  const lines = _cards.map((c, i) => `- #${i + 1} ${c.type}: ${c.title || '(untitled)'}${c.id === _focusedId ? '  <= FRONT' : ''}  [id ${c.id}]`);
  return `[ON SCREEN NOW - the visual panel you are presenting from. You control it with the panel tool. As you talk, bring the relevant card to the FRONT (panel focus) and reference it out loud ("here you can see..."); close a card (panel close) once you're done discussing it. Keep it to what's actually relevant.]\n${lines.join('\n')}`;
}

// Back-compat with the earlier single-feed API.
export function push(a) { return open(a); }
export function recent() { return _cards; }
export function since() { return _cards; }

export default { open, focus, close, clear, state, block, push, recent, since };
