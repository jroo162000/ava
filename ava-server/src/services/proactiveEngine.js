// proactiveEngine.js — AVA's proactive layer.
// Turns her strongest PASSIVE capability — live OS/environment awareness — into a PROACTIVE one:
// instead of only narrating "RAM is 90%" when asked, she NOTICES it and offers to act. She watches
// her environment signals (and her own reflections), scores the single most worthwhile thing to
// raise, names the capability that could fix it, and surfaces it — ALWAYS consent-first (the caller
// has her check you're free before sharing). Built to extend: drop in commitments, email triage,
// or research follow-ups as new candidate sources and they compete in the same scoring.
import os from 'os';
import fs from 'fs';
import path from 'path';
import avaPaths from '../utils/paths.js';
import logger from '../utils/logger.js';
import selfReflections from './selfReflections.js';
import capabilityRegistry from './capabilityRegistry.js';
import { onVoiceEvent } from './voiceBus.js';

const COOLDOWN_MS = Math.max(1, parseInt(process.env.AVA_PROACTIVE_COOLDOWN_HOURS || '6', 10)) * 3600000;
const ENV_COOLDOWN_MS = Math.max(1, parseInt(process.env.AVA_PROACTIVE_ENV_COOLDOWN_HOURS || '72', 10)) * 3600000;
const STATE_PATH = path.join(avaPaths.dataDir(), 'proactive-engine-state.json');
const _lastSurfaced = new Map();             // key -> ts (so she doesn't nag with the same thing)
const _eventCandidates = new Map();
let _envCache = { ts: 0, cands: [] };        // env scan is cheap but cache 60s anyway
let _started = false;

try {
  const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  for (const [key, value] of Object.entries(saved.lastSurfaced || {})) _lastSurfaced.set(key, Number(value) || 0);
} catch { /* first run */ }

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({ lastSurfaced: Object.fromEntries(_lastSurfaced), updatedAt: new Date().toISOString() }, null, 2));
  } catch { /* best-effort */ }
}

function capabilityFor(text) {
  return capabilityRegistry.find(text, 4).map(tool => tool.name).join(' / ');
}

function _cooled(candidate) {
  const t = _lastSurfaced.get(candidate?.key);
  const cooldown = candidate?.kind === 'environment' ? ENV_COOLDOWN_MS : COOLDOWN_MS;
  return !t || (Date.now() - t) > cooldown;
}
export function markSurfaced(key) { if (key) { _lastSurfaced.set(key, Date.now()); saveState(); } }

function envCandidates() {
  if (Date.now() - _envCache.ts < 60000) return _envCache.cands;
  const out = [];
  // RAM pressure — the thing she repeatedly flags. Capability that fixes it: sys_ops / app_control.
  try {
    const total = os.totalmem(), free = os.freemem();
    if (total > 0) {
      const usedPct = Math.round((1 - free / total) * 100);
      const thresh = parseInt(process.env.AVA_PROACTIVE_RAM_PCT || '85', 10);
      if (usedPct >= thresh) {
        out.push({
          key: 'env:ram', kind: 'environment', capability: capabilityFor('inspect memory usage and running applications'),
          severity: 3 + Math.min(2, Math.floor((usedPct - thresh) / 5)),
          text: `Memory's running tight — ${usedPct}% of RAM is in use right now.`,
          offer: "want me to look at what's safe to close?"
        });
      }
    }
  } catch { /* optional */ }
  // Downloads pile-up — also something she flagged. Capability: fs_ops / file_resolve.
  try {
    const dl = path.join(os.homedir(), 'Downloads');
    if (fs.existsSync(dl)) {
      const files = fs.readdirSync(dl).filter(f => !f.startsWith('.'));
      const thresh = parseInt(process.env.AVA_PROACTIVE_DOWNLOADS_COUNT || '300', 10);
      if (files.length >= thresh) {
        out.push({
          key: 'env:downloads', kind: 'environment', capability: capabilityFor('inspect and organize files'), severity: 3,
          text: `Your Downloads folder has ${files.length} items stacking up.`,
          offer: "want me to sort it or clear out the old stuff?"
        });
      }
    }
  } catch { /* optional */ }
  // Long uptime. Capability: sys_ops.
  try {
    const days = os.uptime() / 86400;
    const thresh = parseInt(process.env.AVA_PROACTIVE_UPTIME_DAYS || '7', 10);
    if (days >= thresh) {
      out.push({
        key: 'env:uptime', kind: 'environment', capability: capabilityFor('inspect system uptime and health'), severity: 2,
        text: `This machine's been up ${Math.floor(days)} days straight.`,
        offer: "a reboot might clear some sludge — want me to remind you later?"
      });
    }
  } catch { /* optional */ }
  _envCache = { ts: Date.now(), cands: out };
  return out;
}

function reflectionCandidate() {
  try {
    const r = selfReflections.forShare(1);
    if (r && r.length) {
      return {
        key: 'reflect:' + r[0].key, kind: 'reflection', capability: 'self', severity: 2,
        text: r[0].text, offer: null, _reflectionKey: r[0].key
      };
    }
  } catch { /* optional */ }
  return null;
}

function eventKey(type, subject, detail) {
  return `${type}:${subject}:${String(detail || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80)}`;
}

function rememberEventCandidate(candidate) {
  if (!candidate?.key) return;
  _eventCandidates.set(candidate.key, { ...candidate, observedAt: Date.now() });
}

export function isActionableToolFailureEvent(event) {
  return event?.type === 'tool.result'
    && event?.data?.ok === false
    && event?.source !== 'env';
}

export function start() {
  if (_started) return;
  _started = true;
  onVoiceEvent(event => {
    const data = event?.data || {};
    // Environment polling is best-effort telemetry. Its transient startup misses must not
    // masquerade as user-visible capability failures and recursively spawn repair workflows.
    if (isActionableToolFailureEvent(event)) {
      rememberEventCandidate({
        key: eventKey('tool-failure', data.tool, data.summary || data.status),
        kind: 'tool-failure',
        capability: data.tool || capabilityFor(data.summary),
        severity: 4,
        text: `A recent ${data.tool || 'tool'} attempt failed: ${data.summary || data.status || 'unknown error'}.`,
        offer: 'I can investigate the failure and identify a verified repair.',
      });
    } else if (event?.type === 'workflow' && data.status === 'failed') {
      rememberEventCandidate({
        key: eventKey('workflow-failure', data.id, data.error || data.goal),
        kind: 'workflow-failure',
        capability: capabilityFor(data.goal || data.error),
        severity: 5,
        text: `A durable workflow failed: ${data.goal || data.error || data.id}.`,
        offer: 'I can inspect its receipts and work out a different path.',
      });
    } else if (event?.type === 'commitment.deadline') {
      rememberEventCandidate({
        key: eventKey('commitment', data.id, data.state),
        kind: 'commitment',
        capability: capabilityFor(data.text),
        severity: data.state === 'overdue' ? 5 : 3,
        text: `${data.state === 'overdue' ? 'An overdue' : 'An upcoming'} commitment needs attention: ${data.text}.`,
        offer: 'I can help complete or reschedule it.',
      });
    }
  });
}

function eventCandidates() {
  const ttl = Math.max(1, Number(process.env.AVA_PROACTIVE_EVENT_TTL_HOURS) || 24) * 3600000;
  const out = [];
  for (const [key, candidate] of _eventCandidates) {
    if (Date.now() - candidate.observedAt > ttl) { _eventCandidates.delete(key); continue; }
    out.push(candidate);
  }
  return out;
}

// The single best thing to proactively raise right now (or null). Environment issues outrank an
// evergreen reflection when both are present. Cooldown-gated so she doesn't repeat herself.
export function nextNudge() {
  const cands = [];
  for (const c of envCandidates()) if (_cooled(c)) cands.push(c);
  for (const c of eventCandidates()) if (_cooled(c)) cands.push(c);
  const rc = reflectionCandidate();
  if (rc && _cooled(rc)) cands.push(rc);
  if (!cands.length) return null;
  cands.sort((a, b) => (b.severity || 0) - (a.severity || 0));
  logger.debug('[proactive] nudge selected', { key: cands[0].key, kind: cands[0].kind });
  return cands[0];
}

export default { start, nextNudge, markSurfaced };
