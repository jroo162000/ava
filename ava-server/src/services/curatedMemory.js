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
export function appendFact(target, line) {
  ensureSeed();
  const p = target === 'user' ? userPath() : memoryPath();
  const cap = target === 'user' ? USER_CAP : MEMORY_CAP;
  const clean = String(line || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, error: 'empty' };
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

export default { buildMemoryBlock, appendFact, reload, paths: { userPath, memoryPath } };
