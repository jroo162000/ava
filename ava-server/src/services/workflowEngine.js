// workflowEngine.js — long-horizon, RESUMABLE workflow autonomy for AVA.
//
// Where the single agent loop (agentLoop.js) handles a bounded multi-step task, this engine handles
// a LONG goal: it (1) PLANS the goal into ordered STAGES, (2) runs each stage as a full agent-loop
// run, (3) CHECKPOINTS progress to disk after every stage AND every step so a restart resumes where
// it left off, and (4) REPLANS the remaining stages when one fails, routing around the failure.
//
// Tier 2 #14 (persistent, reliable long-horizon autonomy) adds:
//   - ATOMIC durable state (tmp+rename) so a crash mid-write can't corrupt workflows.json
//   - a per-stage step JOURNAL (tool + outcome per step) checkpointed as it happens, so a crash
//     mid-ACTION is recoverable: the resumed stage is told what already ran and verifies instead
//     of blindly redoing side-effectful actions
//   - a SUPERVISOR watchdog that tells "stuck" from "working" via step heartbeats, announces a
//     stuck workflow aloud once, self-heals orphaned runs, and exposes its verdict on /workflow(s)
//   - a per-stage wall-clock DEADLINE (agentLoop deadlineAt) so a runaway stage stops cleanly
//   - abort(id) to stop a workflow at the next stage/step boundary
//   - spoken announcements for resumed / stuck / finished workflows (announceQueue)
//
// Rollback/tuning: AVA_WORKFLOW_RESUME=0 (no auto-resume on startup), AVA_WORKFLOW_SUPERVISOR=0
// (no watchdog), AVA_WORKFLOW_STAGE_TIMEOUT_MIN (default 20), AVA_WORKFLOW_STUCK_SEC (default 300),
// AVA_WORKFLOW_SUPERVISE_SEC (default 60), AVA_WORKFLOW_ANNOUNCE=0 (silence announcements).
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import llmService from './llm.js';
import agentLoop from './agentLoop.js';
import environmentContext from './environmentContext.js';
import { pushAnnouncement } from './announceQueue.js';
import { emitVoiceEvent } from './voiceBus.js';  // Tier 3 #18: live workflow pipeline for the Stage

const FILE = path.join(process.cwd(), 'data', 'workflows.json');
const MAX_STORED = 50;
const MAX_STAGE_ATTEMPTS = 2;     // retry a failed stage once before replanning
const MAX_REPLANS = 3;            // give up after this many plan revisions
const MAX_PROGRESS_ENTRIES = 30;  // per-stage step journal bound
const STAGE_STEP_LIMIT = parseInt(process.env.AVA_WORKFLOW_STAGE_STEPS || '14', 10);

const _active = new Set();        // workflow ids currently executing (no double-run)
const _abortRequested = new Set();// ids asked to stop at the next boundary

function _stageTimeoutMs() { return (parseInt(process.env.AVA_WORKFLOW_STAGE_TIMEOUT_MIN || '20', 10) || 20) * 60000; }
function _stuckMs() { return (parseInt(process.env.AVA_WORKFLOW_STUCK_SEC || '300', 10) || 300) * 1000; }
function _announceOn() { return process.env.AVA_WORKFLOW_ANNOUNCE !== '0'; }
function _announce(text) { if (_announceOn()) { try { pushAnnouncement(text); } catch { /* best effort */ } } }

function _ensureDir() { try { const d = path.dirname(FILE); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ } }
function _loadAll() {
  try { if (fs.existsSync(FILE)) { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (j && typeof j === 'object') return j; } } catch { /* ignore */ }
  return {};
}
// ATOMIC save (Tier 2 #14): write to a tmp file then rename, so a crash mid-write leaves the
// previous good state intact instead of a truncated JSON that _loadAll would discard entirely.
function _saveAll(map) {
  try {
    _ensureDir();
    const ids = Object.keys(map).sort((a, b) => (map[b].updatedAt || 0) - (map[a].updatedAt || 0)).slice(0, MAX_STORED);
    const trimmed = {}; for (const id of ids) trimmed[id] = map[id];
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) { try { logger.warn('[workflow] save failed', { error: e.message }); } catch { /* ignore */ } }
}
// Checkpoint a single workflow (merge into the on-disk map). This is what makes it resumable.
function _checkpoint(wf) {
  wf.updatedAt = Date.now();
  const map = _loadAll();
  map[wf.id] = wf;
  _saveAll(map);
  _emitWf(wf);
}

// Tier 3 #18: broadcast a compact snapshot of the workflow to the Stage on every checkpoint
// (plan/start/stage-transition/done). Broadcast-only telemetry — the Stage renders it as a
// live pipeline card; the durable state stays in the checkpoint file.
function _emitWf(wf) {
  if (process.env.AVA_WORKFLOW_EVENTS === '0') return;
  try {
    emitVoiceEvent('workflow', {
      id: wf.id,
      goal: String(wf.goal || '').slice(0, 120),
      status: wf.status || 'running',
      currentStage: wf.currentStage | 0,
      stages: (wf.stages || []).map(s => ({
        title: String(s.title || s.goal || 'stage').slice(0, 60),
        status: s.status || 'pending',
      })),
    }, 'workflow');
  } catch { /* ui push is best-effort */ }
}

function _parseLooseJson(text) {
  const s = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Decompose a GOAL into ordered, concrete, agent-executable stages.
async function planGoal(goal) {
  const sys = [
    "You are AVA's workflow planner. Break the GOAL into an ordered list of concrete STAGES.",
    'Each stage is a self-contained sub-goal her agent (with tools for the OS, browser, files, apps,',
    'comms, and her own code) can finish in a handful of steps. Stages run SEQUENTIALLY, each building',
    'on the last; make them specific, actionable, and individually verifiable. Use 2-8 stages — fewer',
    'is better when the goal is simple. Do NOT include vague stages like "plan" or "review" unless they',
    'involve a real action.',
    'Output STRICT JSON only: {"stages":[{"title":"<short label>","goal":"<one concrete instruction for the agent>"}]}',
  ].join('\n');
  try {
    const r = await llmService.chat(
      [{ role: 'system', content: sys }, { role: 'user', content: `GOAL: ${goal}` }],
      { temperature: 0.3, max_tokens: 1200 }
    );
    const j = _parseLooseJson(r.text || r.content || '');
    const stages = (j && Array.isArray(j.stages) ? j.stages : [])
      .filter(s => s && s.goal).slice(0, 12)
      .map((s, i) => ({ n: i + 1, title: String(s.title || `Stage ${i + 1}`).slice(0, 120), goal: String(s.goal).slice(0, 1000), status: 'pending', attempts: 0, result: '', error: '', progress: [] }));
    return stages;
  } catch (e) { logger.warn('[workflow] planGoal failed', { error: e.message }); return []; }
}

// After a stage fails, revise the REMAINING stages to route around the failure.
async function replan(wf, failedIdx, reason) {
  const done = wf.stages.slice(0, failedIdx).filter(s => s.status === 'done')
    .map(s => `- ${s.title}: ${String(s.result || '').slice(0, 160)}`).join('\n') || '(none yet)';
  const failed = wf.stages[failedIdx];
  const sys = [
    "You are AVA's workflow planner REVISING a plan after a stage FAILED. Given the overall goal, the",
    'stages already completed (do NOT redo them), and the stage that failed plus why, output a REVISED',
    'ordered list of the REMAINING stages that route AROUND the failure to still reach the goal. If the',
    'goal is genuinely unachievable now, return {"stages":[],"abandon":"<one line why>"}.',
    'STRICT JSON only: {"stages":[{"title":"<short>","goal":"<concrete agent instruction>"}]}',
  ].join('\n');
  const user = `OVERALL GOAL: ${wf.goal}\n\nALREADY DONE:\n${done}\n\nFAILED STAGE: ${failed.title} — ${failed.goal}\nWHY IT FAILED: ${String(reason || '').slice(0, 400)}`;
  try {
    const r = await llmService.chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.3, max_tokens: 1200 });
    const j = _parseLooseJson(r.text || r.content || '');
    if (j && j.abandon && (!j.stages || !j.stages.length)) return { abandon: String(j.abandon).slice(0, 300) };
    const stages = (j && Array.isArray(j.stages) ? j.stages : []).filter(s => s && s.goal).slice(0, 10)
      .map((s, i) => ({ n: failedIdx + i + 1, title: String(s.title || `Stage ${failedIdx + i + 1}`).slice(0, 120), goal: String(s.goal).slice(0, 1000), status: 'pending', attempts: 0, result: '', error: '', progress: [] }));
    return { stages };
  } catch (e) { logger.warn('[workflow] replan failed', { error: e.message }); return { stages: [] }; }
}

function _completedSummary(wf, upto) {
  const lines = wf.stages.slice(0, upto).filter(s => s.status === 'done')
    .map(s => `- ${s.title}: ${String(s.result || '').slice(0, 180)}`);
  return lines.length ? `Stages already completed in this workflow:\n${lines.join('\n')}\n` : '';
}

// Crash recovery (Tier 2 #14): when a stage was interrupted mid-run, tell the resumed agent
// exactly what already happened so it VERIFIES instead of blindly redoing side effects.
function _priorProgressBlock(stage) {
  if (!stage.interrupted || !Array.isArray(stage.progress) || !stage.progress.length) return '';
  const lines = stage.progress.slice(-12).map(p =>
    `- step ${p.step}: ${p.tool || p.decision || 'action'} -> ${p.status || 'unknown'}${p.note ? ` (${String(p.note).slice(0, 120)})` : ''}`);
  return [
    'IMPORTANT — THIS STAGE WAS INTERRUPTED BY A RESTART MID-RUN. Actions that ALREADY executed before the interruption:',
    ...lines,
    'Do NOT blindly repeat side-effectful actions from that list (sending messages/email, creating events,',
    'writing or deleting files, posting). First VERIFY what actually landed (read state, check the result),',
    'then continue from where it left off. Idempotent reads are fine to redo.',
    '',
  ].join('\n');
}

// Run ONE stage as a full agent-loop run. Returns { ok, result }.
async function _runStage(wf, idx) {
  const stage = wf.stages[idx];
  let env = '';
  try { env = await environmentContext.buildEnvironmentBlock(); } catch { env = ''; }
  const goal = [
    'You are executing ONE stage of a larger workflow. Do THIS stage and nothing beyond it.',
    // AUTONOMOUS long-horizon mode (Tier 2 #14): this stage runs unattended — there is NO human
    // available to answer questions mid-run. Do NOT ask the user for clarification or confirmation;
    // make the most reasonable assumption and proceed to actually DO the work. Only stop if the
    // stage is genuinely impossible with the tools you have.
    'You are running AUTONOMOUSLY with no user present to answer questions. Do not ask for input or',
    'confirmation — make a sensible default choice and complete the action.',
    `OVERALL WORKFLOW GOAL: ${wf.goal}`,
    _completedSummary(wf, idx),
    _priorProgressBlock(stage),
    `THIS STAGE (${stage.title}): ${stage.goal}`,
  ].filter(Boolean).join('\n');

  // Per-step heartbeat + journal (Tier 2 #14): checkpointed as it happens so a crash mid-action
  // leaves an accurate record of what ran, and the supervisor can tell stuck from working.
  const onStep = (state, decision, actionResult) => {
    try {
      const res = actionResult && actionResult.result;
      const entry = {
        step: state.step_count,
        tool: (decision && decision.tool) || '',
        decision: (decision && decision.decision) || '',
        status: res ? String(res.status || '') : '',
        note: res ? String(res.message || '').slice(0, 160) : '',
        ts: Date.now(),
      };
      stage.progress = Array.isArray(stage.progress) ? stage.progress : [];
      stage.progress.push(entry);
      if (stage.progress.length > MAX_PROGRESS_ENTRIES) stage.progress = stage.progress.slice(-MAX_PROGRESS_ENTRIES);
      wf.heartbeatAt = Date.now();
      _checkpoint(wf);
    } catch { /* journaling must never break the stage */ }
  };

  const state = await agentLoop.runAgentLoop(goal, {
    multiStep: true, runTools: true, stepLimit: STAGE_STEP_LIMIT, environment: env, source: 'workflow',
    // Tier 3 #22: read-only workflows (self-initiated proactive investigation) can observe but
    // never write — the agent-loop gate enforces it structurally, so writes stay gated on approval.
    readOnly: !!wf.readOnly,
    deadlineAt: Date.now() + _stageTimeoutMs(),
    onStep,
  });
  const ok = state && state.status === agentLoop.AgentStatus.SUCCESS;
  const result = (state && (state.final_result || (state.last_result && state.last_result.message))) || (ok ? 'Completed.' : 'Did not complete.');
  return { ok, result: String(result).slice(0, 600), steps: state ? state.step_count : 0 };
}

// The orchestrator: run pending stages sequentially, checkpointing + replanning. Resumable.
async function run(id) {
  if (_active.has(id)) return;
  _active.add(id);
  try {
    let map = _loadAll();
    let wf = map[id];
    if (!wf) return;
    wf.status = 'running';
    wf.heartbeatAt = Date.now();
    wf.supervisor = wf.supervisor || {};
    // A stage left mid-flight by a crash/restart: keep its step journal, mark it interrupted so
    // the resumed run verifies-not-redoes, and put it back in line.
    wf.stages.forEach(s => {
      if (s.status === 'running') {
        s.status = 'pending';
        s.interrupted = true;
        wf.log.push({ ts: Date.now(), stage: s.title, status: 'interrupted', progressSteps: (s.progress || []).length });
      }
    });
    _checkpoint(wf);

    while (true) {
      if (_abortRequested.has(id)) {
        _abortRequested.delete(id);
        wf.status = 'aborted';
        wf.log.push({ ts: Date.now(), stage: 'abort', status: 'aborted' });
        _checkpoint(wf);
        _announce(`I stopped the workflow "${String(wf.goal).slice(0, 60)}" like you asked.`);
        return;
      }
      const idx = wf.stages.findIndex(s => s.status === 'pending');
      if (idx === -1) break;  // all stages resolved
      const stage = wf.stages[idx];
      stage.status = 'running'; stage.attempts = (stage.attempts || 0) + 1;
      stage.startedAt = Date.now();
      wf.currentStage = idx;
      wf.heartbeatAt = Date.now();
      _checkpoint(wf);
      logger.info('[workflow] running stage', { id, stage: idx + 1, title: stage.title, attempt: stage.attempts, interrupted: !!stage.interrupted });

      let res;
      try { res = await _runStage(wf, idx); }
      catch (e) { res = { ok: false, result: e.message }; }

      if (res.ok) {
        stage.status = 'done'; stage.result = res.result; stage.error = ''; stage.interrupted = false;
        wf.log.push({ ts: Date.now(), stage: stage.title, status: 'done', steps: res.steps });
        _checkpoint(wf);
        continue;
      }

      // Stage failed: retry once, then replan the remainder.
      stage.error = res.result;
      wf.log.push({ ts: Date.now(), stage: stage.title, status: 'failed', error: res.result });
      if (stage.attempts < MAX_STAGE_ATTEMPTS) {
        stage.status = 'pending';  // retry
        _checkpoint(wf);
        continue;
      }
      stage.status = 'failed';
      if ((wf.replans || 0) >= MAX_REPLANS) {
        wf.status = 'failed';
        wf.error = `Stage "${stage.title}" failed after ${MAX_REPLANS} plan revisions: ${res.result}`;
        _checkpoint(wf);
        _announce(`I couldn't finish the workflow "${String(wf.goal).slice(0, 60)}" — stage "${stage.title}" kept failing even after replanning.`);
        return;
      }
      const rev = await replan(wf, idx, res.result);
      wf.replans = (wf.replans || 0) + 1;
      if (rev.abandon) {
        wf.status = 'failed'; wf.error = `Abandoned after replanning: ${rev.abandon}`;
        wf.log.push({ ts: Date.now(), stage: 'replan', status: 'abandon', error: rev.abandon });
        _checkpoint(wf);
        _announce(`I had to abandon the workflow "${String(wf.goal).slice(0, 60)}": ${rev.abandon}`);
        return;
      }
      if (!rev.stages || !rev.stages.length) {
        wf.status = 'failed'; wf.error = `Could not revise the plan around: ${res.result}`;
        _checkpoint(wf);
        return;
      }
      // Replace the failed stage + everything after it with the revised stages.
      wf.stages = [...wf.stages.slice(0, idx), ...rev.stages.map((s, i) => ({ ...s, n: idx + i + 1 }))];
      wf.log.push({ ts: Date.now(), stage: 'replan', status: 'revised', count: rev.stages.length });
      _checkpoint(wf);
    }

    const failed = wf.stages.some(s => s.status === 'failed');
    wf.status = failed ? 'failed' : 'done';
    wf.currentStage = wf.stages.length;
    if (!failed) wf.result = wf.stages.map(s => `${s.title}: ${s.result}`).join(' | ').slice(0, 1200);
    _checkpoint(wf);
    logger.info('[workflow] finished', { id, status: wf.status });
    _announce(failed
      ? `The workflow "${String(wf.goal).slice(0, 60)}" finished, but at least one stage failed.`
      : `I finished the whole workflow: ${String(wf.goal).slice(0, 80)}.`);
  } catch (e) {
    logger.warn('[workflow] run error', { id, error: e.message });
    try { const map = _loadAll(); if (map[id]) { map[id].status = 'failed'; map[id].error = e.message; _saveAll(map); } } catch { /* ignore */ }
  } finally {
    _active.delete(id);
    _abortRequested.delete(id);
  }
}

// Plan a goal into stages and START running it in the background. Returns the planned workflow.
// opts.readOnly — the whole workflow runs under the agent-loop read-only gate (no side effects).
// opts.origin   — a tag (e.g. 'proactive:env:ram') so callers can find + follow their workflow.
async function start(goal, opts = {}) {
  goal = String(goal || '').trim();
  if (!goal) return { ok: false, error: 'no goal' };
  const stages = await planGoal(goal);
  if (!stages.length) return { ok: false, error: "I couldn't break that into a workable plan." };
  const id = 'wf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const wf = { id, goal, status: 'running', stages, currentStage: 0, replans: 0,
    readOnly: !!opts.readOnly, origin: opts.origin || '',
    createdAt: Date.now(), updatedAt: Date.now(), heartbeatAt: Date.now(), supervisor: {}, log: [], result: '', error: '' };
  _checkpoint(wf);
  setImmediate(() => run(id).catch(() => {}));  // run in the background; caller gets the plan now
  return { ok: true, id, goal, readOnly: wf.readOnly, origin: wf.origin, stages: stages.map(s => ({ n: s.n, title: s.title, goal: s.goal, status: s.status })) };
}

// SUPERVISOR (Tier 2 #14): tells "stuck" from "working". A workflow is WORKING when its step
// heartbeat is fresh; STUCK when a stage has produced no step heartbeat for AVA_WORKFLOW_STUCK_SEC
// (a hung tool call, a wedged provider); ORPHANED when disk says running but no run() owns it in
// this process (crashed runner) — those are self-healed by resuming. Stuck workflows are announced
// aloud ONCE (re-armed if they recover) and the verdict is exposed on /workflow(s).
function _superviseOnce() {
  const map = _loadAll();
  let dirty = false;
  for (const wf of Object.values(map)) {
    if (wf.status !== 'running') continue;
    wf.supervisor = wf.supervisor || {};
    const prevVerdict = wf.supervisor.verdict || '';
    const isActiveHere = _active.has(wf.id);
    const age = Date.now() - (wf.heartbeatAt || wf.updatedAt || 0);

    if (!isActiveHere) {
      // Disk says running but nothing in this process owns it: a crashed/killed runner.
      wf.supervisor.verdict = 'orphaned';
      wf.supervisor.since = wf.supervisor.since || Date.now();
      if (process.env.AVA_WORKFLOW_RESUME !== '0') {
        logger.info('[workflow] supervisor resuming orphaned workflow', { id: wf.id });
        setImmediate(() => run(wf.id).catch(() => {}));
      }
      dirty = true;
      continue;
    }

    if (age > _stuckMs()) {
      const wasStuck = prevVerdict === 'stuck';
      wf.supervisor.verdict = 'stuck';
      wf.supervisor.since = wasStuck ? wf.supervisor.since : Date.now();
      wf.supervisor.staleSec = Math.round(age / 1000);
      if (!wf.supervisor.announcedStuck) {
        wf.supervisor.announcedStuck = true;
        const st = wf.stages[wf.currentStage];
        logger.warn('[workflow] supervisor: STUCK', { id: wf.id, staleSec: wf.supervisor.staleSec, stage: st && st.title });
        _announce(`Heads up — my workflow "${String(wf.goal).slice(0, 60)}" looks stuck on the stage "${st ? st.title : 'unknown'}"; no progress for ${Math.round(age / 60000)} minutes. I'll keep watching, but you may want to check it.`);
      }
      dirty = true;  // stuck: always persist (fresh staleSec + the announce flag)
    } else {
      wf.supervisor.verdict = 'working';
      wf.supervisor.staleSec = Math.round(age / 1000);
      wf.supervisor.announcedStuck = false;  // re-arm if it wedges again later
      // Persist on ANY verdict transition — including the first empty->working — so the API/UI
      // actually see 'working'. (Original bug: dirty was only set when the PRIOR verdict was a
      // non-empty non-working value, so the first working verdict never hit disk.)
      if (prevVerdict !== 'working') dirty = true;
    }
  }
  if (dirty) _saveAll(map);
}

let _supervisorTimer = null;
function startSupervisor() {
  if (_supervisorTimer || process.env.AVA_WORKFLOW_SUPERVISOR === '0') return;
  const everyMs = (parseInt(process.env.AVA_WORKFLOW_SUPERVISE_SEC || '60', 10) || 60) * 1000;
  _supervisorTimer = setInterval(() => { try { _superviseOnce(); } catch (e) { logger.warn('[workflow] supervisor pass failed', { error: e.message }); } }, everyMs);
  if (_supervisorTimer.unref) _supervisorTimer.unref();
  logger.info('[workflow] supervisor started', { everySec: everyMs / 1000, stuckAfterSec: _stuckMs() / 1000 });
}

// Ask a running workflow to stop at the next boundary (stage edge, or a stage's own deadline).
function abort(id) {
  const wf = get(id);
  if (!wf) return { ok: false, error: 'not found' };
  if (['done', 'failed', 'aborted'].includes(wf.status)) return { ok: true, status: wf.status };
  if (_active.has(id)) {
    _abortRequested.add(id);
    return { ok: true, id, status: 'abort_requested', note: 'stops at the next stage boundary' };
  }
  const map = _loadAll();
  if (map[id]) { map[id].status = 'aborted'; _saveAll(map); }
  return { ok: true, id, status: 'aborted' };
}

function get(id) { const wf = _loadAll()[id]; return wf || null; }
function list() {
  const map = _loadAll();
  return Object.values(map).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(w => ({
      id: w.id, goal: w.goal, status: w.status, stages: w.stages.length,
      done: w.stages.filter(s => s.status === 'done').length,
      currentStage: (w.stages[w.currentStage] && w.stages[w.currentStage].title) || '',
      supervisor: (w.supervisor && w.supervisor.verdict) || '',
      updatedAt: w.updatedAt,
    }));
}
// Manually resume a paused/incomplete workflow.
function resume(id) { const wf = get(id); if (!wf) return { ok: false, error: 'not found' }; if (wf.status === 'done') return { ok: true, status: 'done' }; setImmediate(() => run(id).catch(() => {})); return { ok: true, id, status: 'resuming' }; }

// On server startup, resume any workflow that was mid-run when we last stopped. Disable with
// AVA_WORKFLOW_RESUME=0. Also boots the supervisor watchdog.
function resumeIncomplete() {
  try {
    startSupervisor();
    if (process.env.AVA_WORKFLOW_RESUME === '0') { logger.info('[workflow] auto-resume disabled (AVA_WORKFLOW_RESUME=0)'); return; }
    const map = _loadAll();
    for (const wf of Object.values(map)) {
      if (wf.status === 'running' || wf.status === 'planning') {
        logger.info('[workflow] resuming after restart', { id: wf.id, goal: String(wf.goal).slice(0, 80) });
        _announce(`I'm picking my workflow "${String(wf.goal).slice(0, 60)}" back up where it left off before the restart.`);
        setImmediate(() => run(wf.id).catch(() => {}));
      }
    }
  } catch (e) { logger.warn('[workflow] resumeIncomplete failed', { error: e.message }); }
}

export { start, get, list, resume, resumeIncomplete, planGoal, abort, startSupervisor };
export default { start, get, list, resume, resumeIncomplete, planGoal, abort, startSupervisor, _internals: { _superviseOnce, _priorProgressBlock, _saveAll, _loadAll } };
