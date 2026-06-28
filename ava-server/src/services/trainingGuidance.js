// trainingGuidance.js — a bounded, file-backed "playbook" of routing/behavior rules that
// AVA learns during sandbox training. The meta-loop proposes rules, tests them against the
// task verifiers, and keeps only the ones that raise the score. Kept rules are injected into
// the agent's decision prompt in BOTH training and real use, so she actually gets better at
// choosing/using her tools. Read FRESH on every call so the meta-loop can mutate it live
// (no server restart needed between iterations). Disable with AVA_GUIDANCE_OFF=1.
import fs from 'fs';
import path from 'path';
import os from 'os';

const MAX_RULES = 16;
const MAX_LEN = 240;

function integrationDir() {
  return process.env.AVA_INTEGRATION_DIR || path.join(os.homedir(), 'ava', 'ava-integration');
}
function filePath() { return path.join(integrationDir(), 'memory', 'training_guidance.json'); }

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    if (Array.isArray(j)) return { rules: j };
    return { rules: Array.isArray(j.rules) ? j.rules : [] };
  } catch { return { rules: [] }; }
}
function save(rules) {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify({ rules }, null, 2), 'utf8');
  } catch { /* best effort */ }
}

export function listRules() { return load().rules; }

export function addRule(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
  if (!clean) return null;
  // Narrow sanitization: drop promo/cred/API-key/shell-ish guidance so it can't steer behavior.
  const lower = clean.toLowerCase();
  const suspicious = [
    'editor-in-chief', 'subscribe via rss', 'newsletter', 'promo code',
    'api key', 'apikey', 'bearer ', 'authorization: bearer', 'client_secret', 'client secret',
    'password', 'passphrase', 'login with your', 're-authenticate', 're-authentication',
    'ssh ', 'ssh-keygen', 'curl ', 'wget ', 'pip install', 'npm install', 'bash -c', 'powershell '
  ];
  if (suspicious.some((s) => lower.includes(s))) return null;

  const rules = load().rules;
  // dedupe (case-insensitive)
  if (rules.some((r) => (r.text || '').toLowerCase() === clean.toLowerCase())) return rules;
  const id = 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
  rules.push({ id, text: clean, added: new Date().toISOString() });
  while (rules.length > MAX_RULES) rules.shift(); // bounded; drop oldest
  save(rules);
  return id;
}

// Replace the entire rule set (used for snapshot / revert by the meta-loop).
export function setRules(rules) {
  const clean = (Array.isArray(rules) ? rules : [])
    .map((r) => (typeof r === 'string' ? { text: r } : r))
    .filter((r) => r && r.text)
    .map((r) => ({ id: r.id || ('g' + Math.random().toString(36).slice(2)), text: String(r.text).slice(0, MAX_LEN), added: r.added || new Date().toISOString() }))
    .slice(-MAX_RULES);
  save(clean);
  return clean;
}

// Formatted block injected into the decision prompt. Empty string when off / no rules.
export function buildGuidanceBlock() {
  if (process.env.AVA_GUIDANCE_OFF === '1') return '';
  const rules = load().rules;
  if (!rules.length) return '';
  const body = rules.map((r) => `- ${r.text}`).join('\n');
  return `ROUTING & BEHAVIOR GUIDANCE (learned from training — follow these):\n${body}`;
}

export default { listRules, addRule, setRules, buildGuidanceBlock };
