// proactiveAutonomy.js — Tier 3 #22: proactive, multi-day, self-initiated autonomy.
//
// This closes the last Jarvis-tier gap: instead of only NARRATING a problem ("RAM is tight,
// want me to look?") and waiting to be asked, AVA notices a high-value opening, does the
// investigative legwork HERSELF — autonomously, over time, across restarts — and comes back to
// you with EVIDENCE and a SPECIFIC recommendation. She never takes the side-effectful action on
// her own: the investigation runs READ-ONLY (agent-loop readOnly gate; she can read/scan/
// enumerate but physically cannot write/send/delete/execute), and the actual fix stays behind
// your approval exactly as before.
//
// The lifecycle (durable in data/proactive-initiatives.json, so it spans days + restarts):
//   1. a scheduler tick asks proactiveEngine for the single best opening (cooldown-gated)
//   2. openings that warrant real investigation start a READ-ONLY workflow (workflowEngine),
//      which brings all of Tier 2 #14's machinery: staged plan, per-step checkpoints, crash
//      recovery, the stuck-vs-working supervisor, and stage deadlines
//   3. later ticks follow the workflow; when it finishes, she distills the findings into a
//      concrete recommendation + the one gated action she'd take, files it as an INITIATIVE
//      "awaiting your approval", and announces it ONCE, consent-first
//   4. you approve (say the word) or dismiss; acting on it goes through the normal approval path
//
// Rollback/tuning: AVA_PROACTIVE_AUTONOMY=0 (off entirely), AVA_PROACTIVE_AUTONOMY_MIN (tick
// minutes, default 30), AVA_PROACTIVE_MAX_ACTIVE (concurrent investigations, default 1),
// AVA_PROACTIVE_INITIATIVE_TTL_HOURS (drop stale awaiting/closed initiatives, default 72).
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import llmService from './llm.js';
import workflowEngine from './workflowEngine.js';
import proactiveEngine from './proactiveEngine.js';
import { pushAnnouncement } from './announceQueue.js';
import { emitVoiceEvent } from './voiceBus.js';

const FILE = path.join(process.cwd(), 'data', 'proactive-initiatives.json');
const MAX_STORED = 40;

function _on() { return process.env.AVA_PROACTIVE_AUTONOMY !== '0'; }
function _tickMs() { return Math.max(1, parseInt(process.env.AVA_PROACTIVE_AUTONOMY_MIN || '30', 10)) * 60000; }
function _maxActive() { return Math.max(1, parseInt(process.env.AVA_PROACTIVE_MAX_ACTIVE || '1', 10)); }
function _ttlMs() { return Math.max(1, parseInt(process.env.AVA_PROACTIVE_INITIATIVE_TTL_HOURS || '72', 10)) * 3600000; }

function _ensureDir() { try { const d = path.dirname(FILE); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ } }
function _load() {
  try { if (fs.existsSync(FILE)) { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (Array.isArray(j)) return j; } } catch { /* ignore */ }
  return [];
}
// Atomic write (tmp+rename) so a crash mid-write can't corrupt the initiatives store.
function _save(list) {
  try {
    _ensureDir();
    const trimmed = list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, MAX_STORED);
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) { try { logger.warn('[proactive-auto] save failed', { error: e.message }); } catch { /* ignore */ } }
}

// Which openings are worth an autonomous READ-ONLY investigation, and the concrete read-only
// goal to hand the workflow. Openings not listed here (e.g. evergreen reflections, a simple
// uptime nudge) are left to the conversational proactive layer — this engine only takes on
// things where real legwork produces a better, evidence-backed recommendation.
function investigationFor(nudge) {
  if (!nudge || !nudge.key) return null;
  if (nudge.key === 'env:ram') {
    return {
      goal: [
        'READ-ONLY investigation (take NO action, change nothing): the machine is under memory pressure.',
        'Use sys_ops to read current memory usage and the top processes by RAM. Identify which heavy',
        'processes are ordinary user apps that would be safe to close versus system-critical ones that',
        'must stay. Produce a concise finding: the top 3-5 memory consumers with their RAM, and a clear',
        'recommendation of which specific apps could be closed to recover memory. Do NOT close anything.',
      ].join(' '),
    };
  }
  if (nudge.key === 'env:downloads') {
    return {
      goal: [
        'READ-ONLY investigation (take NO action, change nothing): the Downloads folder has piled up.',
        'Use fs_ops to list the Downloads folder and characterize it — how many items, rough breakdown by',
        'type (installers, images, documents, archives, etc.), and how many look old or large. Produce a',
        'concise finding and a specific cleanup recommendation (what to archive or delete). Do NOT move or',
        'delete anything.',
      ].join(' '),
    };
  }
  return null;
}

// Distill a finished read-only workflow into { finding, recommendation, action } — the evidence
// she gathered plus the ONE gated thing she'd do about it. Falls back to the raw result text.
async function _distill(nudge, wf) {
  const evidence = (wf.stages || []).filter(s => s.status === 'done')
    .map(s => `- ${s.title}: ${String(s.result || '').slice(0, 400)}`).join('\n') || String(wf.result || '').slice(0, 800);
  const sys = [
    "You are AVA. You just finished a READ-ONLY investigation you started on your own initiative.",
    'From the evidence, write JSON only: {"finding":"<what you actually found, specific, 1-2 sentences>",',
    '"recommendation":"<the specific fix you suggest>","action":"<the single concrete action you would take',
    'if approved, phrased as an instruction to yourself>","worth_raising":true|false}.',
    'Set worth_raising=false if the evidence shows there is nothing actually worth doing. Be concrete and',
    'honest — cite the real numbers/names from the evidence, never invent them.',
  ].join('\n');
  const user = `WHAT PROMPTED THIS: ${nudge.text}\n\nEVIDENCE GATHERED:\n${evidence}`;
  try {
    const r = await llmService.chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.2, max_tokens: 500 });
    const m = String(r.text || r.content || '').replace(/^```(?:json)?\s*|\s*```$/g, '').match(/\{[\s\S]*\}/);
    if (m) { const j = JSON.parse(m[0]); if (j && j.finding) return j; }
  } catch (e) { logger.warn('[proactive-auto] distill failed', { error: e.message }); }
  return { finding: String(wf.result || evidence).slice(0, 300), recommendation: nudge.offer || '', action: '', worth_raising: true };
}

function _emit(list) {
  if (process.env.AVA_PROACTIVE_EVENTS === '0') return;
  try {
    const awaiting = list.filter(i => i.status === 'awaiting_approval')
      .map(i => ({ id: i.id, title: i.nudgeText, finding: i.finding, recommendation: i.recommendation }));
    emitVoiceEvent('proactive.initiatives', { pending: awaiting }, 'proactive');
  } catch { /* ui push best-effort */ }
}

// One scheduler pass: follow active investigations to completion, then maybe open a new one.
async function tickOnce() {
  if (!_on()) return;
  let list = _load();
  const now = Date.now();
  let dirty = false;

  // Drop stale awaiting/closed initiatives so the store (and the tray) don't accrete forever.
  const before = list.length;
  list = list.filter(i => !(['awaiting_approval', 'closed', 'failed'].includes(i.status) && (now - (i.updatedAt || 0)) > _ttlMs()));
  if (list.length !== before) dirty = true;

  // 1) Follow every in-flight investigation.
  for (const i of list) {
    if (i.status !== 'investigating' || !i.wfId) continue;
    const wf = workflowEngine.get(i.wfId);
    if (!wf) { i.status = 'failed'; i.error = 'workflow vanished'; i.updatedAt = now; dirty = true; continue; }
    if (wf.status === 'running' || wf.status === 'planning') continue;  // still working / supervised
    if (wf.status !== 'done') {
      i.status = 'failed'; i.error = `investigation ${wf.status}`; i.updatedAt = now; dirty = true;
      logger.info('[proactive-auto] investigation did not complete', { id: i.id, wf: wf.status });
      continue;
    }
    // Investigation finished — distill + file the gated recommendation.
    const distilled = await _distill({ key: i.nudgeKey, text: i.nudgeText, offer: i.recommendation }, wf);
    i.finding = String(distilled.finding || '').slice(0, 400);
    i.recommendation = String(distilled.recommendation || '').slice(0, 400);
    i.action = String(distilled.action || '').slice(0, 400);
    i.updatedAt = now;
    if (distilled.worth_raising === false) {
      i.status = 'closed';
      logger.info('[proactive-auto] investigation closed (nothing worth raising)', { id: i.id });
    } else {
      i.status = 'awaiting_approval';
      logger.info('[proactive-auto] initiative awaiting approval', { id: i.id, finding: i.finding.slice(0, 80) });
      // Consent-first announcement — she reports what she found and offers the specific fix.
      pushAnnouncement(`When you've got a sec — I looked into something on my own. ${i.finding}${i.recommendation ? ' ' + i.recommendation : ''} Want me to go ahead? Just say the word.`.slice(0, 500));
    }
    dirty = true;
  }

  // 2) Maybe open a new investigation (respect the concurrency cap).
  const active = list.filter(i => i.status === 'investigating').length;
  if (active < _maxActive()) {
    let nudge = null;
    try { nudge = proactiveEngine.nextNudge(); } catch { nudge = null; }
    const inv = investigationFor(nudge);
    if (nudge && inv) {
      try {
        const started = await workflowEngine.start(inv.goal, { readOnly: true, origin: `proactive:${nudge.key}` });
        if (started && started.ok) {
          proactiveEngine.markSurfaced(nudge.key);  // cooldown: don't re-investigate the same thing
          list.push({
            id: 'init-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5),
            nudgeKey: nudge.key, nudgeText: nudge.text, capability: nudge.capability || '',
            recommendation: nudge.offer || '', wfId: started.id, status: 'investigating',
            createdAt: now, updatedAt: now,
          });
          dirty = true;
          logger.info('[proactive-auto] opened a read-only investigation', { key: nudge.key, wf: started.id });
        }
      } catch (e) { logger.warn('[proactive-auto] failed to open investigation', { error: e.message }); }
    }
  }

  if (dirty) { _save(list); _emit(list); }
}

let _timer = null;
function start() {
  if (_timer || !_on()) { if (!_on()) logger.info('[proactive-auto] disabled (AVA_PROACTIVE_AUTONOMY=0)'); return; }
  // A first pass shortly after boot (let the worker/tools warm up), then on the cadence.
  setTimeout(() => { tickOnce().catch(e => logger.warn('[proactive-auto] first tick failed', { error: e.message })); }, 90000);
  _timer = setInterval(() => { tickOnce().catch(e => logger.warn('[proactive-auto] tick failed', { error: e.message })); }, _tickMs());
  if (_timer.unref) _timer.unref();
  logger.info('[proactive-auto] started', { everyMin: _tickMs() / 60000, maxActive: _maxActive() });
}

function list() { return _load(); }
function pending() { return _load().filter(i => i.status === 'awaiting_approval'); }
function dismiss(id) {
  const all = _load();
  const i = all.find(x => x.id === id);
  if (!i) return { ok: false, error: 'not found' };
  i.status = 'closed'; i.updatedAt = Date.now();
  _save(all); _emit(all);
  return { ok: true, id, status: 'closed' };
}

export { start, tickOnce, list, pending, dismiss };
export default { start, tickOnce, list, pending, dismiss, _internals: { investigationFor, _distill } };
