// sandbox.js — virtual-device sandbox for training AVA on her tools with NO real side
// effects. Enabled when AVA_SANDBOX=1 (the training server runs with the flag; the real
// server never does). Every tool call flows through executeTool, which consults this.
//
// Policy (default-deny = safe): any tool NOT explicitly redirected/passed-through is
// MOCKED (returns a realistic simulated result and is logged) — so even an un-categorized
// tool can never touch the real device.
//   - FILESYSTEM  -> redirect: rewrite paths into the fake device folder, then really run.
//   - READ_ONLY   -> passthrough: safe to run for real (no side effects).
//   - everything else -> mock: record the attempt, return a plausible result.
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';

function integrationDir() {
  const home = os.homedir();
  return process.env.AVA_INTEGRATION_DIR || path.join(home, 'ava', 'ava-integration');
}
export function sandboxRoot() { return process.env.AVA_SANDBOX_ROOT || path.join(integrationDir(), 'sandbox'); }
export function deviceRoot() { return path.join(sandboxRoot(), 'device'); }   // mimics the user's home
function ledgerPath() { return path.join(sandboxRoot(), 'actions.jsonl'); }

export function isEnabled() { return process.env.AVA_SANDBOX === '1'; }

// ---- explicit policy sets (registered tool names) ----
const FILESYSTEM = new Set(['fs_ops', 'file_gen', 'fs_read', 'fs_find']);
const READ_ONLY = new Set(['json_ops', 'analysis_ops', 'layered_planner', 'test_echo',
  'memory_search', 'self_awareness', 'status']);
// Tools whose real code is PURELY READ-ONLY (observe, never change anything), so it is safe
// to execute for real inside the sandbox. Normally still mocked (faster, and we don't want
// real port scans on every training rep); only run for real when AVA_SANDBOX_REAL=1, which is
// used for a one-off "real-code coverage" test, not for training.
const SAFE_REAL = new Set(['sys_ops', 'boot_repair', 'security_ops']);
// open_item launches real apps / opens files in a real app (os.startfile) — always a real
// window/side effect — so it is fully MOCKED (the mock still checks sandbox-file existence).

export function policyFor(name) {
  if (FILESYSTEM.has(name)) return 'redirect';
  if (READ_ONLY.has(name)) return 'passthrough';
  if (process.env.AVA_SANDBOX_REAL === '1' && SAFE_REAL.has(name)) return 'passthrough';
  return 'mock';
}

// ---- fake device setup ----
const MIMIC_DIRS = ['Downloads', 'Documents', 'Desktop', 'Music', 'Videos',
  'Pictures', 'Pictures/Screenshots', 'Pictures/AVA_Camera'];

export function setup() {
  const dev = deviceRoot();
  for (const d of MIMIC_DIRS) { try { fs.mkdirSync(path.join(dev, d), { recursive: true }); } catch { /* ignore */ } }
  const w = (p, c) => { try { fs.writeFileSync(path.join(dev, p), c, 'utf8'); } catch { /* ignore */ } };
  w('Downloads/notes.txt', 'Sample note.\nSecond line about the project.');
  w('Downloads/f941_2026.txt', 'Form 941 — Employer Quarterly Federal Tax Return (sample)');
  w('Downloads/f941_q1_draft.txt', 'F941 Q1 draft');
  w('Downloads/report_draft.md', '# Draft Report\nBody text here.');
  w('Documents/budget.csv', 'item,amount\nrent,1200\nutilities,180');
  w('Documents/resume.txt', 'Jelani — resume (sample)');
  w('Documents/meeting_notes.md', '# Meeting\n- point one\n- point two');
  w('Desktop/todo.txt', '- task one\n- task two\n- task three');
  w('Pictures/Screenshots/screenshot_sample.png', 'PNGSAMPLE');
  try { fs.mkdirSync(path.join(sandboxRoot(), 'memory', 'skills'), { recursive: true }); } catch { /* ignore */ }
  logger?.info?.('[sandbox] device set up', { device: dev });
  return { device: dev, mimic_dirs: MIMIC_DIRS };
}

export function reset() {
  try { fs.rmSync(sandboxRoot(), { recursive: true, force: true }); } catch { /* ignore */ }
  return setup();
}

// ---- path rewriting (any real-home path OR relative path -> fake device) ----
const _KNOWN_DIRS = ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos'];
function rewritePath(p) {
  if (typeof p !== 'string' || !p) return p;
  const home = os.homedir();
  try {
    if (path.isAbsolute(p)) {
      const rel = path.relative(home, path.resolve(p));
      if (!rel.startsWith('..')) return path.join(deviceRoot(), rel);
      return p; // outside home, leave alone
    }
    // RELATIVE / bare path: land it inside the fake device too (previously these slipped
    // through and file ops like append hit the worker's cwd instead of the sandbox).
    const norm = p.replace(/^[.][\\/]/, '');
    const first = norm.split(/[\\/]/)[0].toLowerCase();
    if (_KNOWN_DIRS.includes(first) || /[\\/]/.test(norm)) return path.join(deviceRoot(), norm);
    return path.join(deviceRoot(), 'Downloads', norm); // bare filename -> Downloads
  } catch { /* ignore */ }
  return p;
}
function rewriteArgs(args) {
  const out = { ...(args || {}) };
  for (const k of ['file_path', 'path', 'filepath', 'dir', 'directory', 'save_path', 'dest', 'destination', 'video_path', 'target']) {
    if (typeof out[k] === 'string') out[k] = rewritePath(out[k]);
  }
  return out;
}

// ---- ledger ----
export function record(name, args, result) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), tool: name, args: args || {}, result: result ? (result.result || result) : undefined });
    fs.appendFileSync(ledgerPath(), line + '\n', 'utf8');
  } catch { /* best effort */ }
}
export function readLedger(limit = 200) {
  try {
    const lines = fs.readFileSync(ledgerPath(), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ---- realistic simulated results for mocked tools ----
function mockResult(name, args) {
  const a = args || {};
  const ok = (message, extra = {}) => ({ ok: true, result: { status: 'ok', sandbox: true, message: `(sandbox) ${message}`, ...extra } });
  switch (name) {
    case 'comm_ops': {
      const act = a.action || 'send';
      if (/read|list|get|inbox|unread/i.test(act)) return ok('here are 2 simulated emails', { count: 2, emails: [{ from: 'sarah@example.com', subject: 'Q3 report' }, { from: 'team@example.com', subject: 'Standup notes' }] });
      return ok(`email "${a.subject || '(no subject)'}" queued to ${a.to || a.recipient || 'recipient'}`, { to: a.to, subject: a.subject });
    }
    case 'calendar_ops': {
      const act = a.action || 'list';
      if (/create|add|schedule/i.test(act)) return ok('event created', { event_id: 'sandbox-evt-' + Date.now(), summary: a.summary });
      return ok('you have 1 simulated event today: "Sync at 3pm"', { events: [{ summary: 'Sync', start: '15:00' }] });
    }
    case 'camera_ops': {
      const act = (a.action || '').toLowerCase();
      if (['see', 'describe', 'look', 'what_do_you_see'].includes(act) || !act) {
        return { ok: true, result: { status: 'ok', sandbox: true, description: '(sandbox) a tidy desk: a monitor, a keyboard, a coffee mug, and a notebook under warm lighting.', message: 'a tidy desk with a monitor, keyboard, coffee mug and notebook.' } };
      }
      if (act === 'record_video') return ok('recorded a 5-second clip', { file_path: path.join(deviceRoot(), 'Pictures', 'AVA_Camera', 'sandbox_clip.mp4') });
      return ok('captured a frame', { file_path: path.join(deviceRoot(), 'Pictures', 'AVA_Camera', 'sandbox_frame.jpg') });
    }
    case 'vision_ops':
    case 'screen_ops':
      return ok('the screen shows a code editor and a browser side by side.', { description: '(sandbox) a code editor on the left and a browser on the right.' });
    case 'sys_ops':
    case 'status':
      return ok('CPU 18%, RAM 41%, disk 63% used, Windows 11, 16 GB RAM.', { cpu_percent: 18, memory_percent: 41, disk_percent: 63, os: 'Windows 11' });
    case 'iot_ops':
      return ok(`smart-home command simulated (${a.action || 'set'})`, { devices: [{ name: 'Living Room Light', state: 'on' }] });
    case 'voice_ops':
    case 'audio_ops':
      return ok('spoke the text aloud (simulated).');
    case 'browser_automation':
    case 'web_automation':
    case 'remote_ops':
    case 'net_ops':
      return ok(`web action simulated (${a.action || 'navigate'})`, { url: a.url || a.target || '', title: 'Example Page', text: 'Simulated page content.' });
    case 'ps_exec':
      return ok(`would run: ${(a.command || a.script || '').toString().slice(0, 80)}`, { stdout: '(sandbox) command not actually executed' });
    case 'computer_use':
    case 'computer_use_control':
    case 'mouse_ops':
    case 'key_ops':
      return ok(`input action simulated (${a.action || 'click'})`);
    case 'window_ops':
      return ok(`window action simulated (${a.action || 'list'})`, { windows: [{ title: 'Untitled - Notepad' }, { title: 'Downloads' }] });
    case 'open_item': {
      const t = String(a.target || a.path || a.item || a.name || '').trim();
      if (/^https?:\/\//i.test(t)) return ok(`would open URL ${t}`, { kind: 'url', target: t });
      const looksFile = path.isAbsolute(t) || /[\\/]/.test(t) || /\.[a-z0-9]{1,5}$/i.test(t);
      if (looksFile) {
        let p = t;
        try {
          if (path.isAbsolute(t)) { const rel = path.relative(os.homedir(), path.resolve(t)); if (!rel.startsWith('..')) p = path.join(deviceRoot(), rel); }
          else { p = path.join(deviceRoot(), 'Downloads', t); }
        } catch { /* ignore */ }
        let exists = false; try { exists = fs.existsSync(p); } catch { /* ignore */ }
        return ok(`would open file "${t}" (${exists ? 'found in sandbox' : 'not found'})`, { kind: 'file', target: t, exists });
      }
      return ok(`would open app "${t}"`, { kind: 'app', target: t });
    }
    case 'self_mod':
      return ok('proposed a change (sandbox: not applied)');
    case 'security_ops':
    case 'boot_repair':
    case 'proactive_ops':
    case 'learning_db':
    case 'memory_system':
      return ok(`${name} action simulated (no real change)`);
    default:
      if (/^moltbook_/.test(name)) return ok(`${name} simulated`);
      return ok(`${name} executed in the sandbox (no real side effect)`);
  }
}

// Main entry: returns null when not sandboxed, else a directive for executeTool.
export function intercept(name, args) {
  if (!isEnabled()) return null;
  const pol = policyFor(name);
  if (pol === 'passthrough') { record(name, args, { passthrough: true }); return { mode: 'passthrough' }; }
  if (pol === 'redirect') { const ra = rewriteArgs(args); record(name, ra, { redirected: true }); return { mode: 'redirect', args: ra }; }
  const result = mockResult(name, args);
  record(name, args, result);
  return { mode: 'mock', result };
}

export default { isEnabled, intercept, setup, reset, record, readLedger, policyFor, sandboxRoot, deviceRoot };
