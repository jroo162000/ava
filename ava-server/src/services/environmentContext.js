// environmentContext.js — AVA's live "local OS-integration" awareness layer (v1).
// Gives her read-only, real-time context about the user's Windows machine — foreground
// window/app, CPU/RAM, uptime, and her OWN recent actions — injected into her prompts so
// "this window", "this screen/tab", "why is it slow", and "what did you just do" resolve to
// reality instead of a guess. Heavy bits (psutil CPU, window list) refresh in the BACKGROUND
// so they never add latency to a reply. Toggle off with AVA_ENV_AWARENESS_OFF=1.
import os from 'os';
import { execFile } from 'child_process';
import toolsService from './tools.js';
import artifactMemory from './artifactMemory.js';
import actionHistory from './actionHistory.js';
import logger from '../utils/logger.js';

let _cache = { ts: 0, cpu: '', window: '', disk: '' };
let _refreshing = false;

// Recent changes to HER OWN source code (so she KNOWS when she's been upgraded instead of
// insisting she's "the same as before"). git log from the server dir (inside the repo); cached
// 5 min, refreshed in the background. Falls back to the standard Git-for-Windows path.
let _codeCache = { ts: 0, text: '' };
let _codeRefreshing = false;
function _refreshCode() {
  if (_codeRefreshing) return;
  if (_codeCache.text && Date.now() - _codeCache.ts < 300000) return;
  _codeRefreshing = true;
  const dir = process.cwd();
  const gitArgs = ['-C', dir, 'log', '-n', '6', '--pretty=format:%h %ad %s', '--date=short'];
  const opts = { timeout: 6000, windowsHide: true };
  const finish = (out) => {
    const lines = String(out || '').trim().split('\n').filter(Boolean).slice(0, 6);
    _codeCache = { ts: Date.now(), text: lines.join(' | ') || _codeCache.text };
    _codeRefreshing = false;
  };
  execFile('git', gitArgs, opts, (err, stdout) => {
    if (!err && stdout) return finish(stdout);
    execFile('C:\\Program Files\\Git\\cmd\\git.exe', gitArgs, opts, (e2, out2) => {
      if (!e2 && out2) return finish(out2);
      _codeCache = { ts: Date.now(), text: _codeCache.text };
      _codeRefreshing = false;
    });
  });
}

async function _refresh() {
  if (_refreshing) return;
  _refreshing = true;
  try {
    try {
      const r = await toolsService.executeTool('window_ops', { action: 'list' }, false, { source: 'env', bypassIdempotency: true });
      const inner = (r && (r.result || r)) || {};
      const wins = inner.windows || (inner.result && inner.result.windows) || [];
      const act = Array.isArray(wins) ? wins.find(w => w && w.active && w.title) : null;
      _cache.window = act ? String(act.title).slice(0, 140) : (_cache.window || '');
    } catch { /* best effort */ }
    try {
      const r = await toolsService.executeTool('sys_ops', { action: 'info' }, false, { source: 'env', bypassIdempotency: true });
      const inner = (r && (r.result || r)) || {};
      const si = inner.system_info || inner;
      if (si && si.cpu && si.cpu.cpu_usage) _cache.cpu = String(si.cpu.cpu_usage);
      // first disk partition % if present
      try {
        const disks = si && si.disk;
        const first = Array.isArray(disks) ? disks[0] : (disks && Object.values(disks)[0]);
        if (first && first.percentage) _cache.disk = `${first.mountpoint || first.device || 'disk'} ${first.percentage}`;
      } catch { /* optional */ }
    } catch { /* best effort */ }
    _cache.ts = Date.now();
  } finally { _refreshing = false; }
}

// Returns a concise text block (or '' if nothing useful). Never blocks: triggers a background
// refresh when stale and returns whatever's cached + the instant Node-os stats.
export async function buildEnvironmentBlock() {
  if (process.env.AVA_ENV_AWARENESS_OFF === '1') return '';
  if (Date.now() - _cache.ts > 6000) { _refresh().catch(() => {}); }
  const lines = [];
  if (_cache.window) lines.push(`Foreground window/app right now (title, redacted): "${_cache.window}"`);
  if (_cache.cpu) lines.push(`CPU usage: ${_cache.cpu}`);
  try {
    const total = os.totalmem(), free = os.freemem();
    if (total > 0) {
      const usedPct = Math.round((1 - free / total) * 100);
      const gb = (n) => (n / 1073741824).toFixed(1);
      lines.push(`RAM: ${usedPct}% used (${gb(total - free)} of ${gb(total)} GB)`);
    }
    const up = os.uptime();
    if (up > 60) lines.push(`Machine uptime: ${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`);
    // Network: best-effort connectivity from Node os (instant, reliable).
    try {
      const ifaces = os.networkInterfaces() || {};
      let ip = '';
      for (const name of Object.keys(ifaces)) {
        for (const ni of (ifaces[name] || [])) {
          if (ni && ni.family === 'IPv4' && !ni.internal) { ip = ni.address; break; }
        }
        if (ip) break;
      }
      lines.push(ip ? `Network: connected (local IP ${ip})` : 'Network: no active connection detected');
    } catch { /* optional */ }
  } catch { /* optional */ }
  if (_cache.disk) lines.push(`Disk: ${_cache.disk} used`);
  // Her own recent actions — from the real action-history log (richer than just artifacts).
  try {
    let acts = '';
    try { acts = actionHistory.summarize && actionHistory.summarize(6); } catch { acts = ''; }
    if (acts) {
      lines.push(`What you actually just did (most recent last) — answer "what did you just do?" from this: ${acts}`);
    } else {
      const recent = (artifactMemory.recent && artifactMemory.recent(5)) || [];
      const items = recent.map(a => a && (a.value || a.path || a.url || a.id)).filter(Boolean)
        .map(x => String(x).split(/[\\/]/).pop()).slice(0, 5);
      if (items.length) lines.push(`Things you just produced/opened this session (most recent last): ${items.join('; ')}`);
    }
  } catch { /* optional */ }
  // Recent changes to HER OWN source code — so she KNOWS she's actively being upgraded and never
  // says "I'm the same as before / I haven't received the upgrades". For "have you been upgraded?",
  // "what changed in your code?", run the self_diagnostics tool for the full picture.
  try {
    _refreshCode();
    if (_codeCache.text) {
      lines.push(`Recent changes to YOUR OWN source code (git, newest first) — you ARE being upgraded; for a full "what changed in my code" report run the self_diagnostics tool: ${_codeCache.text}`);
    }
  } catch { /* optional */ }
  if (!lines.length) return '';
  return 'LIVE ENVIRONMENT — read-only awareness of the user\'s Windows machine right now. Use this so "this window", "this screen/tab", "why is it slow/full", and "what did you just do / undo what you just did" map to reality; do NOT guess or speculate when these tell you the answer, and don\'t read this aloud unless it\'s relevant:\n- ' + lines.join('\n- ');
}

export default { buildEnvironmentBlock };
