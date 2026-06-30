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
import logger from '../utils/logger.js';
import selfReflections from './selfReflections.js';

const COOLDOWN_MS = Math.max(1, parseInt(process.env.AVA_PROACTIVE_COOLDOWN_HOURS || '6', 10)) * 3600000;
const _lastSurfaced = new Map();             // key -> ts (so she doesn't nag with the same thing)
let _envCache = { ts: 0, cands: [] };        // env scan is cheap but cache 60s anyway

function _cooled(key) { const t = _lastSurfaced.get(key); return !t || (Date.now() - t) > COOLDOWN_MS; }
export function markSurfaced(key) { if (key) _lastSurfaced.set(key, Date.now()); }

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
          key: 'env:ram', kind: 'environment', capability: 'sys_ops / app_control',
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
          key: 'env:downloads', kind: 'environment', capability: 'fs_ops / file_resolve', severity: 3,
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
        key: 'env:uptime', kind: 'environment', capability: 'sys_ops', severity: 2,
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

// The single best thing to proactively raise right now (or null). Environment issues outrank an
// evergreen reflection when both are present. Cooldown-gated so she doesn't repeat herself.
export function nextNudge() {
  const cands = [];
  for (const c of envCandidates()) if (_cooled(c.key)) cands.push(c);
  const rc = reflectionCandidate();
  if (rc && _cooled(rc.key)) cands.push(rc);
  if (!cands.length) return null;
  cands.sort((a, b) => (b.severity || 0) - (a.severity || 0));
  logger.debug('[proactive] nudge selected', { key: cands[0].key, kind: cands[0].kind });
  return cands[0];
}

export default { nextNudge, markSurfaced };
