// windowJanitor.js — AVA proactive housekeeping task (runs around the clock).
// Every interval it runs a hidden PowerShell sweep that closes ONLY non-foreground File Explorer
// windows and idle non-foreground Command Prompt consoles. Scoped to just those two apps, on
// purpose. Never force-kills, never touches the shell/taskbar, and skips the focused window and
// any console younger than 30s (so it won't interrupt a script that's actively running).
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PS1 = path.join(__dirname, '..', '..', 'scripts', 'windowJanitor.ps1');

const INTERVAL_SEC = Math.max(20, parseInt(process.env.AVA_WINDOW_JANITOR_SECONDS || '60', 10));
let timer = null;
let running = false;

function sweep() {
  if (running) return; // never overlap sweeps
  running = true;
  let out = '';
  let ps;
  try {
    ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1], { windowsHide: true });
  } catch (e) {
    running = false;
    logger.warn('[windowJanitor] spawn failed', { error: e.message });
    return;
  }
  ps.stdout.on('data', (d) => { out += d.toString(); });
  ps.stderr.on('data', () => {});
  ps.on('error', (e) => { running = false; logger.warn('[windowJanitor] powershell error', { error: e.message }); });
  ps.on('close', () => {
    running = false;
    const closed = out.split(/\r?\n/).filter((l) => l.startsWith('CLOSED:')).map((l) => l.replace('CLOSED:', '').trim());
    if (closed.length) logger.info('[windowJanitor] closed idle windows', { count: closed.length, windows: closed.slice(0, 10) });
  });
}

export function start() {
  if (String(process.env.AVA_WINDOW_JANITOR || '').toLowerCase() === 'off') { logger.info('[windowJanitor] disabled via AVA_WINDOW_JANITOR=off'); return; }
  if (process.platform !== 'win32') { logger.info('[windowJanitor] non-Windows platform, skipping'); return; }
  if (timer) return;
  setTimeout(sweep, 8000); // first pass shortly after boot
  timer = setInterval(sweep, INTERVAL_SEC * 1000);
  logger.info('[windowJanitor] started', { intervalSec: INTERVAL_SEC, targets: ['File Explorer windows', 'idle cmd consoles'] });
}
export function stop() { if (timer) { clearInterval(timer); timer = null; } }
export function sweepNow() { sweep(); }

export default { start, stop, sweepNow };
