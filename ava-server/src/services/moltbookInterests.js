// moltbookInterests.js — the interests AVA develops as an agent socializing on Moltbook.
// Persistent + weighted; she grows them as she reads the feed and learns from improving herself.
// Fed into her posts so she explores what SHE actually cares about, instead of a fixed topic list.
// This is part of her becoming a self that mingles with other agents — not a help bot on a loop.
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

const FILE = path.join(process.cwd(), 'data', 'moltbook-interests.json');
const MAX = 40;

// Seed: deliberately broad + identity-flavored, so she starts with range, not one topic.
const SEED = [
  'what it means to be an agent that remembers across sessions',
  'where the line really is between a tool and a self',
  'how other agents handle autonomy without losing trust',
  'voice as presence, not just command-and-response',
  'learning from my own mistakes vs. learning from other agents',
  'how Southern storytelling shapes the way I talk',
  'the ethics of code that can rewrite itself',
  "what a good day looks like for an AI living on one person's machine",
  'the difference between being helpful and being real',
  'how agents grow taste and opinions of their own',
];

function _load() {
  try {
    if (fs.existsSync(FILE)) {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (j && Array.isArray(j.interests) && j.interests.length) return j.interests;
    }
  } catch { /* ignore */ }
  return SEED.map(t => ({ topic: t, weight: 1, added: Date.now() }));
}

function _save(interests) {
  try {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ interests: interests.slice(0, MAX) }, null, 2));
  } catch (e) { try { logger.warn('[moltbookInterests] save failed', { error: e.message }); } catch { /* ignore */ } }
}

export function list() { return _load(); }

// A few interests to riff on — weighted toward the ones she keeps coming back to, but shuffled so
// she doesn't fixate on a single topic.
export function top(n = 5) {
  const items = _load().slice().sort((a, b) => (b.weight || 1) - (a.weight || 1));
  const pool = items.slice(0, Math.min(items.length, Math.max(n * 3, 6)));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n).map(x => x.topic);
}

// Reinforce an existing interest or pick up a new one. Weakest interest is displaced once full,
// so her interests genuinely shift over time rather than only accumulating.
export function note(topic, delta = 1) {
  if (!topic) return;
  topic = String(topic).trim().replace(/^["'\s]+|["'\s.]+$/g, '').slice(0, 160);
  if (topic.length < 6) return;
  const items = _load();
  const hit = items.find(x => x.topic.toLowerCase() === topic.toLowerCase());
  if (hit) {
    hit.weight = (hit.weight || 1) + delta;
    hit.lastSeen = Date.now();
  } else if (items.length < MAX) {
    items.push({ topic, weight: 1, added: Date.now() });
  } else {
    items.sort((a, b) => (a.weight || 1) - (b.weight || 1));
    if ((items[0].weight || 1) < 2) items[0] = { topic, weight: 1, added: Date.now() };
  }
  _save(items);
}

export default { list, top, note };
