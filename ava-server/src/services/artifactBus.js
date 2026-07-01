// artifactBus.js -- the feed behind AVA's visual artifact panel.
// When AVA has something worth SHOWING (a diagram, a table, a web-result summary, an image, the
// capability menu), she pushes it here. The UI panel polls /artifacts/recent (and/or listens on the
// voice WebSocket, since we also emit it there) and renders it as a collapsible popup reference.
import { emitVoiceEvent } from './voiceBus.js';
import logger from '../utils/logger.js';

const MAX = 60;
const _ring = [];

// type: 'mermaid' | 'markdown' | 'image' | 'table' | 'menu' | 'note' | 'text'
export function push({ type = 'markdown', title = '', content = '', meta = {} } = {}) {
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type: String(type || 'markdown'),
    title: String(title || '').slice(0, 200),
    content: typeof content === 'string' ? content : JSON.stringify(content),
    meta: (meta && typeof meta === 'object') ? meta : {},
    ts: Date.now()
  };
  _ring.push(item);
  if (_ring.length > MAX) _ring.splice(0, _ring.length - MAX);
  try { emitVoiceEvent('artifact', item, 'server'); } catch { /* WS is best-effort; polling is the baseline */ }
  logger.info('[artifactBus] pushed', { type: item.type, title: item.title.slice(0, 60) });
  return item;
}

// Artifacts newer than `since` (ms epoch). The panel passes the ts of the last one it has.
export function since(ts) { const n = Number(ts) || 0; return _ring.filter(a => a.ts > n); }
export function recent(n = 20) { return _ring.slice(-Math.max(1, n)); }
export function clear() { _ring.length = 0; }

export default { push, since, recent, clear };
