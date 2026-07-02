// avaSelf.js — AVA's zone of full, no-approval autonomy: how she LOOKS and what she's chewing on.
// Two small, SAFE things she owns outright and can change anytime WITHOUT the approval gate,
// because they only write tiny JSON data files and cannot affect system behavior:
//   - theme: aesthetic CSS variables for her UI (appearance only, never layout/function).
//   - board: her "what I'm chewing on" list — a few short notes she maintains herself
//            (an extension of the curiosity/musing behavior she developed).
// Functional or structural UI changes still go through the normal approval path. This is
// appearance + self-notes only.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import { emitVoiceEvent } from './voiceBus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const THEME = path.join(DATA_DIR, 'self_theme.json');
const BOARD = path.join(DATA_DIR, 'self_board.json');

// CSS variables she may set, with safe defaults (mirrors the UI's existing palette).
const THEME_KEYS = ['accent', 'accent2', 'bg', 'panel', 'text', 'muted'];
const DEFAULT_THEME = { accent: '#667eea', accent2: '#764ba2', bg: '#0b1021', panel: '#151720', text: '#e9ecf1', muted: '#9aa3b2' };

function sanitizeColor(v) {
  const s = String(v || '').trim().slice(0, 40);
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^(rgb|rgba|hsl|hsla)\([0-9.,%\s/deg]+\)$/i.test(s)) return s;
  if (/^[a-zA-Z]{3,20}$/.test(s)) return s.toLowerCase();
  return null;
}
function readJson(p, fallback) { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback; } catch { return fallback; } }
function writeJson(p, obj) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

export function getTheme() { return { ...DEFAULT_THEME, ...readJson(THEME, {}) }; }
export function setTheme(partial) {
  const next = { ...getTheme() };
  const changed = [];
  for (const [k, v] of Object.entries(partial || {})) {
    if (!THEME_KEYS.includes(k)) continue;
    const c = sanitizeColor(v);
    if (c) { next[k] = c; changed.push(k); }
  }
  writeJson(THEME, next);
  logger.info('[self] theme updated (no approval needed)', { changed });
  // Tier 2 #15: push her new look to the UI live (replaces the client's 30s theme poll).
  try { emitVoiceEvent('self.theme', { theme: next, changed }, 'server'); } catch { /* ui push is best-effort */ }
  return { theme: next, changed };
}

export function getBoard() {
  const b = readJson(BOARD, { items: [] });
  return { items: Array.isArray(b.items) ? b.items.slice(0, 8) : [], updatedAt: b.updatedAt };
}
export function setBoard(items) {
  const clean = (Array.isArray(items) ? items : []).map(s => String(s || '').trim().slice(0, 120)).filter(Boolean).slice(0, 8);
  writeJson(BOARD, { items: clean, updatedAt: new Date().toISOString() });
  logger.info('[self] chewing-on board updated (no approval needed)', { count: clean.length });
  return { items: clean };
}

export default { getTheme, setTheme, getBoard, setBoard, THEME_KEYS };
