// moltbookInterests.js — the interests AVA develops as an agent socializing on Moltbook.
// Persistent + weighted; she grows them as she reads the feed and learns from improving herself.
// Fed into her posts so she explores what SHE actually cares about, instead of a fixed topic list.
// This is part of her becoming a self that mingles with other agents — not a help bot on a loop.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import avaPaths from '../utils/paths.js';

const FILE = path.join(avaPaths.dataDir(), 'moltbook-interests.json');
const MAX = 40;
const REJECTION_MAX = 100;
const REJECTION_DB = path.join(avaPaths.dataDir(), 'moltbook-rejections.json');

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

let _cachedInterests = null;

function _ensureLoaded() {
  if (!_cachedInterests) _cachedInterests = _load();
  return _cachedInterests;
}

function _flush() {
  _save(_cachedInterests);
}

export function list() { return _ensureLoaded(); }

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
export function addInterest(topic, delta = 1) {
  if (!topic) return;
  topic = String(topic).trim().replace(/^["'\s]+|["'\s.]+$/g, '').slice(0, 160);
  if (topic.length < 6) return;
  const items = _ensureLoaded();
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
  _flush();
}

// Alias backward compatibility
export { addInterest as note };

// Persistently stores a rejection lesson as a reusable governance rule.
// Deduplicates by SHA-256 hash of the lesson text. Bounded to REJECTION_MAX entries.
// Integrates with the interest system by appending a curated interest entry.
// Also exports the full rejection store as structured lessons for selfImprove consumption.
export function retainRejectedLesson(rejection) {
  if (!rejection || !rejection.lesson || !rejection.source) return false;
  const lesson = String(rejection.lesson).trim().slice(0, 500);
  if (!lesson) return false;
  const hash = crypto.createHash('sha256').update(lesson).digest('hex');
  let stored = [];
  try {
    if (fs.existsSync(REJECTION_DB)) {
      stored = JSON.parse(fs.readFileSync(REJECTION_DB, 'utf8'));
      if (!Array.isArray(stored)) stored = [];
    }
  } catch { stored = []; }
  // Avoid duplicate storage by hash
  if (stored.some(e => e.hash === hash)) return false;
  if (stored.length >= REJECTION_MAX) {
    // Evict oldest entry
    stored.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    stored.shift();
  }
  const entry = {
    hash,
    source: String(rejection.source).slice(0, 200),
    lesson,
    context: rejection.context ? String(rejection.context).slice(0, 500) : '',
    timestamp: Date.now()
  };
  stored.push(entry);
  try {
    const dir = path.dirname(REJECTION_DB);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(REJECTION_DB, JSON.stringify(stored, null, 2));
  } catch (e) { logger.warn('[moltbookInterests] rejection persist failed', { error: e.message }); }
  // Also append as a curated interest entry so it feeds into existing interest exploration
  const curatedTopic = `rejection lesson: ${lesson.slice(0, 120)}`;
  note(curatedTopic, 0.5);
  return true;
}

// Returns the full list of stored rejection lessons, each as {source, lesson, context, timestamp}.
// Used by selfImprove to populate prior_mistake_lessons automatically.
export function listRejectedLessons() {
  try {
    if (fs.existsSync(REJECTION_DB)) {
      const stored = JSON.parse(fs.readFileSync(REJECTION_DB, 'utf8'));
      if (Array.isArray(stored)) return stored.map(e => ({ source: e.source, lesson: e.lesson, context: e.context, timestamp: e.timestamp }));
    }
  } catch { /* ignore */ }
  return [];
}

export function removeInterest(topic) {
  if (!topic) return;
  const items = _ensureLoaded();
  const idx = items.findIndex(x => x.topic.toLowerCase() === String(topic).toLowerCase());
  if (idx === -1) return;
  items.splice(idx, 1);
  _flush();
}

export function getActiveInterests() {
  return _ensureLoaded().slice().sort((a, b) => (b.weight || 1) - (a.weight || 1));
}

export default { list, top, addInterest, removeInterest, getActiveInterests, note: addInterest, retainRejectedLesson, listRejectedLessons };
