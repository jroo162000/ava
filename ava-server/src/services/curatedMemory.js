// Curated, always-on memory — AVA's "brain" block, injected into every prompt.
// Pattern from Hermes/OpenClaw: small, bounded, curated, always present (not retrieved).
//  - USER.md   : durable facts about the user (who they are, preferences, habits)
//  - MEMORY.md : AVA's own notes (environment facts, conventions, lessons learned)
// Both are bounded so they stay signal, not noise. Background reviewers (P2) write here.
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';

const USER_CAP = 1500;    // chars
const MEMORY_CAP = 2000;  // chars

function integrationDir() {
  const home = os.homedir();
  return process.env.AVA_INTEGRATION_DIR || path.join(home, 'ava', 'ava-integration');
}
function memDir() { return path.join(integrationDir(), 'memory'); }
function userPath() { return path.join(memDir(), 'USER.md'); }
function memoryPath() { return path.join(memDir(), 'MEMORY.md'); }

function ensureSeed() {
  try {
    fs.mkdirSync(memDir(), { recursive: true });
    if (!fs.existsSync(userPath())) {
      let name = 'the user', dev = '';
      try {
        const id = JSON.parse(fs.readFileSync(path.join(integrationDir(), 'ava_identity.json'), 'utf8'));
        name = (id.trust_system && id.trust_system.user_name) || name;
        dev = id.developer || '';
      } catch { /* identity optional */ }
      const seed = [
        `Name: ${name}.`,
        dev ? `${name} is AVA's developer (${dev}) and primary user.` : `${name} is AVA's primary user.`,
        `Builds and uses AVA, a local voice assistant on a Windows PC.`,
      ].join('\n') + '\n';
      fs.writeFileSync(userPath(), seed, 'utf8');
    }
    if (!fs.existsSync(memoryPath())) {
      fs.writeFileSync(memoryPath(),
        "AVA runs as a local voice assistant (Node server + Python voice listener) on the user's Windows computer.\n",
        'utf8');
    }
  } catch (e) {
    logger?.warn?.('[curatedMemory] seed failed', { error: e.message });
  }
}

function readCapped(p, cap) {
  try {
    let t = fs.readFileSync(p, 'utf8').trim();
    if (t.length > cap) t = t.slice(0, cap).trim();
    return t;
  } catch {
    return '';
  }
}

let _cache = null;

export function buildMemoryBlock(force = false) {
  if (process.env.AVA_MEMORY_OFF === '1') return '';   // control switch for A/B verification
  if (_cache !== null && !force) return _cache;
  ensureSeed();
  const user = readCapped(userPath(), USER_CAP);
  const mem = readCapped(memoryPath(), MEMORY_CAP);
  if (!user && !mem) { _cache = ''; return ''; }
  const parts = ['WHAT YOU KNOW (persistent memory — treat as true unless the user corrects you; never invent beyond it):'];
  if (user) parts.push('About the user:\n' + user);
  if (mem) parts.push('Your notes (environment, conventions, lessons):\n' + mem);
  _cache = parts.join('\n\n');
  return _cache;
}

// Bounded write API used by the P2 background reviewers (and manual edits).
// Structured observation storage — appends timestamped text lines to the correct memory file.
export function storeObservation(category, text_lines) {
  ensureSeed();
  if (!Array.isArray(text_lines) || text_lines.length === 0) return { ok: false, error: 'empty_lines', stored: 0 };
  const validCats = { 'USER.md': 'user', 'MEMORY.md': 'env' };
  const fileKey = validCats[category];
  if (!fileKey) return { ok: false, error: 'invalid_category', stored: 0 };
  const p = fileKey === 'user' ? userPath() : memoryPath();
  const cap = fileKey === 'user' ? USER_CAP : MEMORY_CAP;
  const ts = new Date().toISOString();
  const header = `[observation @ ${ts}]`;
  const cleanLines = [];
  for (const line of text_lines) {
    const clean = String(line || '').replace(/\s+/g, ' ').trim();
    if (clean) cleanLines.push(clean);
  }
  if (cleanLines.length === 0) return { ok: true, stored: 0 };
  const body = cleanLines.map(l => `  - ${l}`).join('\n');
  const block = `\n${header}\n${body}\n`;
  try {
    let t = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    const newContent = t.trimEnd() + block;
    const totalChars = newContent.length;
    let trimmed = newContent;
    while (trimmed.length > cap) {
      // Remove oldest observation block (from start)
      const idx = trimmed.indexOf('\n[observation @ ');
      if (idx === -1) break;
      const endIdx = trimmed.indexOf('\n[observation @ ', idx + 1);
      const blockEnd = (endIdx === -1) ? trimmed.length : endIdx;
      trimmed = trimmed.slice(0, idx) + trimmed.slice(blockEnd);
    }
    fs.writeFileSync(p, trimmed, 'utf8');
    _cache = null;
    return { ok: true, stored: cleanLines.length };
  } catch (e) {
    return { ok: false, error: e.message, stored: 0 };
  }
}

export function appendFact(target, line) {
  ensureSeed();
  const p = target === 'user' ? userPath() : memoryPath();
  const cap = target === 'user' ? USER_CAP : MEMORY_CAP;
  const clean = String(line || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, error: 'empty' };
  const isMoltbookComment = /\bmoltbook\b/i.test(clean) && /\b(comment|rss|editor-in-chief|eni_novelist)\b/i.test(clean);
  const authSolicitation = /\b(api[-_\s]?key|authentication|re-authentication|credentials?)\b/i.test(clean) && /\b(request|provide|send|enter|reauthenticate|re-authenticate|curl)\b/i.test(clean);
  const promoBoilerplate = /\b(editor-in-chief|rss ad|promotional rss|subscribe now|sponsored)\b/i.test(clean);
  if (isMoltbookComment && (authSolicitation || promoBoilerplate)) return { ok: false, quarantined: true, error: 'untrusted-external-comment' };
  try {
    let t = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    if (t.toLowerCase().includes(clean.toLowerCase())) return { ok: true, deduped: true };
    const lines = (t.trim() ? t.trim().split('\n') : []).concat(clean);
    let joined = lines.join('\n') + '\n';
    while (joined.length > cap && lines.length > 1) { lines.shift(); joined = lines.join('\n') + '\n'; }
    fs.writeFileSync(p, joined, 'utf8');
    _cache = null;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function reload() { _cache = null; return buildMemoryBlock(true); }

// ── Engagement signal storage ──────────────────────────────────────────
// Stores observable user-engagement signals (interruptions, corrections, refinements)
// as timestamped facts. Used by curiositySupervisor, conversationLogger, persona.

const SIGNAL_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Record an observable engagement signal for a topic.
 * @param {string} topic - Normalized topic identifier (lowercase, no punctuation)
 * @param {'interruption'|'repeated_question'|'correction'|'refinement'} signalType
 * @param {object} [meta={}] - Optional context (e.g. { conversationId, utterance })
 * @returns {{ ok: boolean, error?: string }}
 */
export function storeEngagementSignal(topic, signalType, meta = {}) {
  const validSignals = ['interruption', 'repeated_question', 'correction', 'refinement'];
  if (!topic || typeof topic !== 'string') return { ok: false, error: 'invalid_topic' };
  if (!validSignals.includes(signalType)) return { ok: false, error: 'invalid_signal_type' };
  const cleanTopic = topic.replace(/[^a-z0-9_]/gi, '_').toLowerCase().replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!cleanTopic) return { ok: false, error: 'empty_topic_after_clean' };
  const ts = Date.now();
  const line = `[engagement] topic=${cleanTopic} type=${signalType} ts=${ts} meta=${JSON.stringify(meta)}`;
  const result = appendFact('user', line);
  if (!result.ok && !result.deduped) return { ok: false, error: result.error };
  return { ok: true };
}

/**
 * Get a normalized engagement score (0–1) for a topic, based on a decaying-weighted
 * sum over signals recorded in the last 24 hours.
 * @param {string} topic
 * @returns {number} score 0–1 (0 = no engagement, 1 = maximum)
 */
export function getTopicEngagement(topic) {
  if (!topic || typeof topic !== 'string') return 0;
  const cleanTopic = topic.replace(/[^a-z0-9_]/gi, '_').toLowerCase().replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!cleanTopic) return 0;
  const facts = queryFacts('user', `[engagement] topic=${cleanTopic}`);
  if (!facts || facts.length === 0) return 0;
  const now = Date.now();
  const cutoff = now - SIGNAL_RETENTION_MS;
  const WEIGHTS = { interruption: 0.8, repeated_question: 0.6, correction: 1.0, refinement: 0.7 };
  // Decay: score contribution halves every 6 hours (half-life = 21600000 ms)
  // decayFactor = 0.5 ^ ((now - ts) / halfLife)
  const halfLife = 6 * 60 * 60 * 1000;
  let totalWeighted = 0;
  let totalMax = 0;
  for (const f of facts) {
    // f is the raw line text; extract ts and type via regex
    const tsMatch = f.match(/ts=(\d+)/);
    if (!tsMatch) continue;
    const observedTs = parseInt(tsMatch[1], 10);
    if (observedTs < cutoff) continue;
    const typeMatch = f.match(/type=(\S+)/);
    if (!typeMatch) continue;
    const observedType = typeMatch[1];
    const weight = WEIGHTS[observedType] || 0.5;
    const ageMs = now - observedTs;
    const decay = Math.pow(0.5, ageMs / halfLife);
    totalWeighted += weight * decay;
    totalMax += weight; // max possible if all happened just now
  }
  if (totalMax === 0) return 0;
  return Math.min(1, totalWeighted / totalMax);
}

// Helper to query facts from user memory by prefix match
function queryFacts(target, prefix) {
  ensureSeed();
  const p = target === 'user' ? userPath() : memoryPath();
  if (!fs.existsSync(p)) return [];
  try {
    const text = fs.readFileSync(p, 'utf8');
    return text.split('\n').filter(line => line.includes(prefix)).map(l => l.trim());
  } catch { return []; }
}

export default { buildMemoryBlock, appendFact, reload, storeEngagementSignal, getTopicEngagement, paths: { userPath, memoryPath } };
