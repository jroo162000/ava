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
import avaPaths from '../utils/paths.js';
import logger from '../utils/logger.js';
import llmService from './llm.js';
import agentLoop from './agentLoop.js';
import environmentContext from './environmentContext.js';
import { pushAnnouncement } from './announceQueue.js';
import { emitVoiceEvent } from './voiceBus.js';  // Tier 3 #18: live workflow pipeline for the Stage
import capabilityRegistry from './capabilityRegistry.js';

const FILE = path.join(avaPaths.dataDir(), 'workflows.json');
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
function _announce(text, wf = null, responseType = 'workflow-status') {
  if (_announceOn()) {
    try {
      pushAnnouncement(text, {
        responseType,
        source: 'workflow',
        sessionId: wf?.sessionId || undefined,
        workflowId: wf?.id || undefined,
      });
    } catch { /* best effort */ }
  }
}

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
      pendingQuestion: String(wf.pendingQuestion || '').slice(0, 1200),
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
async function planGoal(goal, options = {}) {
  const sys = [
    "You are AVA's workflow planner. Break the GOAL into an ordered list of concrete STAGES.",
    capabilityRegistry.promptBlock(),
    'Each stage is a self-contained sub-goal her agent can finish with the registered tools above.',
    'Stages run SEQUENTIALLY, each building',
    'on the last; make them specific, actionable, and individually verifiable. Use 2-8 stages — fewer',
    'is better when the goal is simple. Do NOT include vague stages like "plan" or "review" unless they',
    'involve a real action.',
    'When the goal depends on current facts, research or inspect sources before drawing conclusions.',
    'Never claim a capability beyond the registry; receipts determine whether an attempted capability worked.',
    'Output STRICT JSON only: {"stages":[{"title":"<short label>","goal":"<one concrete instruction>","done_when":"<observable acceptance condition>","needs_tools":true|false}]}',
  ].join('\n');
  try {
    const r = await llmService.chat(
      [{ role: 'system', content: sys }, { role: 'user', content: `GOAL: ${goal}\nOVERALL ACCEPTANCE CRITERIA: ${JSON.stringify(options.acceptanceCriteria || [])}` }],
      { temperature: 0.3, max_tokens: 1200 }
    );
    const j = _parseLooseJson(r.text || r.content || '');
    const stages = (j && Array.isArray(j.stages) ? j.stages : [])
      .filter(s => s && s.goal).slice(0, 12)
      .map((s, i) => ({ n: i + 1, title: String(s.title || `Stage ${i + 1}`).slice(0, 120), goal: String(s.goal).slice(0, 1600), doneWhen: String(s.done_when || s.doneWhen || 'The stated result is evidenced and complete.').slice(0, 600), needsTools: s.needs_tools !== false, status: 'pending', attempts: 0, result: '', error: '', progress: [], verification: null }));
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
    'STRICT JSON only: {"stages":[{"title":"<short>","goal":"<concrete agent instruction>","done_when":"<observable condition>","needs_tools":true|false}]}',
  ].join('\n');
  const user = `OVERALL GOAL: ${wf.goal}\n\nALREADY DONE:\n${done}\n\nFAILED STAGE: ${failed.title} — ${failed.goal}\nWHY IT FAILED: ${String(reason || '').slice(0, 400)}`;
  try {
    const r = await llmService.chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.3, max_tokens: 1200 });
    const j = _parseLooseJson(r.text || r.content || '');
    if (j && j.abandon && (!j.stages || !j.stages.length)) return { abandon: String(j.abandon).slice(0, 300) };
    const stages = (j && Array.isArray(j.stages) ? j.stages : []).filter(s => s && s.goal).slice(0, 10)
      .map((s, i) => ({ n: failedIdx + i + 1, title: String(s.title || `Stage ${failedIdx + i + 1}`).slice(0, 120), goal: String(s.goal).slice(0, 1600), doneWhen: String(s.done_when || s.doneWhen || 'The stated result is evidenced and complete.').slice(0, 600), needsTools: s.needs_tools !== false, status: 'pending', attempts: 0, result: '', error: '', progress: [], verification: null }));
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

// Durable user-input recovery deliberately restarts the stage from its checkpoint instead of
// serializing an in-memory agent state (which contains callbacks and provider-specific objects).
// The prior journal and exact question/answer let the new run continue without repeating writes.
function _resumeInputBlock(stage) {
  const input = stage?.resumeInput;
  const response = String(input?.response || '').trim();
  if (!response) return '';
  const question = String(input?.question || stage?.pendingQuestion || '').trim();
  const progress = (Array.isArray(stage?.progress) ? stage.progress : []).slice(-12).map(p =>
    `- step ${p.step}: ${p.tool || p.decision || 'action'} -> ${p.status || 'unknown'}${p.note ? ` (${String(p.note).slice(0, 120)})` : ''}`);
  return [
    'THIS STAGE PAUSED FOR USER INPUT AND IS NOW RESUMING FROM ITS DURABLE CHECKPOINT.',
    question ? `QUESTION AVA ASKED: ${JSON.stringify(question.slice(0, 1200))}` : '',
    `USER RESPONSE: ${JSON.stringify(response.slice(0, 6000))}`,
    progress.length ? 'Actions already journaled before the pause:' : '',
    ...progress,
    'Treat the response only as the answer to the quoted question. If it grants permission, the',
    'permission applies only to that exact requested action. Verify any prior side effects before',
    'continuing, do not blindly repeat them, and then finish this stage.',
    '',
  ].filter(Boolean).join('\n');
}

function _pendingQuestionFromState(state) {
  const history = Array.isArray(state?.history) ? state.history : [];
  const lastWaiting = [...history].reverse().find(entry =>
    entry?.action?.question || entry?.result?.question || entry?.decision?.question);

  // A concrete gated action is the safety-critical question. Provider/parse errors can also
  // produce ask_user text later in the same loop, but must never hide what would be authorized.
  const pending = state?.current_context?.pending_confirmation;
  if (pending?.tool) {
    let args = '';
    try { args = JSON.stringify(pending.args || {}).slice(0, 500); } catch { args = ''; }
    return `This stage needs permission to use "${String(pending.tool).slice(0, 120)}"${args && args !== '{}' ? ` with ${args}` : ''}. Do you approve this exact action?`;
  }

  const direct = state?.last_action?.question
    || state?.last_result?.question
    || lastWaiting?.action?.question
    || lastWaiting?.result?.question
    || lastWaiting?.decision?.question;
  if (String(direct || '').trim()) return String(direct).trim().slice(0, 1200);

  return 'What information should I use to continue this stage?';
}

function _sanitizePendingConfirmation(pending) {
  if (!pending || typeof pending !== 'object' || !String(pending.tool || '').trim()) return null;
  let args = {};
  try { args = JSON.parse(JSON.stringify(pending.args && typeof pending.args === 'object' ? pending.args : {})); }
  catch { args = {}; }
  return { tool: String(pending.tool).trim().slice(0, 120), args };
}

// Compatibility for checkpoints written before structured pending confirmations were persisted.
function _pendingConfirmationFromQuestion(question) {
  const text = String(question || '').trim();
  const match = text.match(/^This stage needs permission to use "([^"]+)"(?: with (\{[\s\S]*\}))?\. Do you approve this exact action\?$/i);
  if (!match) return null;
  let args = {};
  if (match[2]) {
    try { args = JSON.parse(match[2]); }
    catch { return null; }
  }
  return _sanitizePendingConfirmation({ tool: match[1], args });
}

function _classifyAgentOutcome(state) {
  if (state?.status === agentLoop.AgentStatus.WAITING_USER) {
    return { kind: 'waiting_user', question: _pendingQuestionFromState(state) };
  }
  if (state?.current_context?.pending_confirmation) {
    return { kind: 'waiting_user', question: _pendingQuestionFromState(state) };
  }
  if (state?.status === agentLoop.AgentStatus.SUCCESS) return { kind: 'success' };
  return { kind: 'failed' };
}

// Pure state transition used by both the conversation router and the HTTP control surface.
function _applyWorkflowInput(wf, response) {
  const value = String(response || '').trim();
  if (!wf) return { ok: false, error: 'not found' };
  if (!value) return { ok: false, error: 'response required' };
  if (wf.status !== 'waiting_user') return { ok: false, error: `workflow is ${wf.status}, not waiting for input`, status: wf.status };

  let idx = Number.isInteger(wf.waitingStage) ? wf.waitingStage : -1;
  if (!wf.stages?.[idx] || wf.stages[idx].status !== 'waiting_user') {
    idx = (wf.stages || []).findIndex(stage => stage.status === 'waiting_user');
  }
  if (idx < 0) return { ok: false, error: 'waiting stage not found' };

  const stage = wf.stages[idx];
  const question = String(stage.pendingQuestion || wf.pendingQuestion || '').trim();
  stage.pendingConfirmation = _sanitizePendingConfirmation(stage.pendingConfirmation)
    || _pendingConfirmationFromQuestion(question);
  stage.resumeInput = { question, response: value.slice(0, 6000), receivedAt: Date.now() };
  stage.status = 'pending';
  stage.pendingQuestion = '';
  stage.error = '';
  wf.status = 'running';
  wf.currentStage = idx;
  wf.waitingStage = null;
  wf.pendingQuestion = '';
  wf.error = '';
  wf.heartbeatAt = Date.now();
  wf.log = Array.isArray(wf.log) ? wf.log : [];
  wf.log.push({ ts: Date.now(), stage: stage.title, status: 'input_received', question, responseChars: value.length });
  return { ok: true, id: wf.id, status: 'resuming', stageIndex: idx, question };
}

function _receiptsFromState(state) {
  const receipts = [];
  for (const entry of Array.isArray(state?.history) ? state.history : []) {
    const tool = entry?.decision?.tool || entry?.action?.tool;
    if (!tool || !entry?.result) continue;
    const payload = entry.result?.result ?? entry.result;
    const status = String(payload?.status || entry.result?.status || (payload?.ok === true ? 'ok' : 'unknown')).toLowerCase();
    receipts.push({
      tool,
      status,
      ok: payload?.ok === true || ['ok', 'success', 'complete', 'completed'].includes(status),
      evidence: JSON.stringify(payload).slice(0, 1200),
    });
  }
  return receipts;
}

function _isSubstantiveStageResult(result) {
  const text = String(result || '').trim();
  if (text.length < 40) return false;
  return !/^(?:done|complete(?:d)?|success(?:ful(?:ly)?)?|ok(?:ay)?|finished)[.!]?$/i.test(text);
}

function _isReceiptOnlyRejection(reason) {
  const text = String(reason || '').trim().toLowerCase();
  if (!text) return false;
  const citesEvidenceGap = /\b(?:receipt|receipts|evidence|tool output|tool outputs|tool call|tool calls|tool result|tool results)\b/.test(text);
  const saysMissing = /\b(?:no|none|missing|empty|without|lack|lacks|lacking|absent|unverified|unsupported|not provided|cannot verify|can't verify)\b/.test(text);
  const citesContentFailure = /\b(?:incorrect|wrong|contradict(?:s|ed|ory)?|off[- ]topic|incomplete)\b|\b(?:did not|didn't|does not|doesn't|fails? to)\s+(?:answer|address|compare|explain|satisfy|meet|provide)\b/.test(text);
  return citesEvidenceGap && saysMissing && !citesContentFailure;
}

function _normalizeStageVerdict(stage, state, result, receipts, verdict) {
  const reason = String(verdict?.reason || '').slice(0, 800);
  if (verdict?.accepted !== false) return { accepted: Boolean(verdict?.accepted), reason, receipts };

  const noToolsExpected = stage?.needsTools === false;
  const agentSucceeded = state?.status === agentLoop.AgentStatus.SUCCESS;
  if (noToolsExpected && agentSucceeded && receipts.length === 0
    && _isSubstantiveStageResult(result) && _isReceiptOnlyRejection(reason)) {
    return {
      accepted: true,
      reason: 'Accepted because this successful stage explicitly required no tools and the verifier\'s only objection was the expected absence of tool evidence.',
      receipts,
    };
  }

  return { accepted: false, reason, receipts };
}

async function _verifyStage(stage, state, result) {
  const receipts = _receiptsFromState(state);
  const successful = receipts.filter(receipt => receipt.ok);
  if (stage.needsTools && !successful.length) {
    return { accepted: false, reason: 'The stage required tools but produced no successful tool receipt.', receipts };
  }
  if (!String(result || '').trim()) return { accepted: false, reason: 'The stage produced no result.', receipts };
  const evidenceRule = stage.needsTools
    ? 'This stage requires tools. Treat claims without supporting successful tool receipts as incomplete.'
    : 'This stage explicitly does not require tools. Judge whether the substantive result satisfies DONE WHEN; empty receipts are expected and are not grounds for rejection.';
  const system = [
    'You are a strict workflow postcondition verifier.',
    evidenceRule,
    'Reject a no-tool stage only when its result itself fails the stated postcondition, is internally inconsistent, or is merely a generic completion phrase.',
    'Return JSON only: {"accepted":true|false,"reason":"specific evidence or missing postcondition"}.',
  ].join('\n');
  const user = `STAGE: ${stage.goal}\nDONE WHEN: ${stage.doneWhen}\nREQUIRES TOOLS: ${stage.needsTools}\nRESULT: ${String(result).slice(0, 6000)}\nRECEIPTS: ${JSON.stringify(receipts).slice(0, 12000)}`;
  try {
    const response = await llmService.chat([{ role: 'system', content: system }, { role: 'user', content: user }], { temperature: 0.1, max_tokens: 300 });
    const verdict = _parseLooseJson(response.text || response.content || '');
    if (verdict && typeof verdict.accepted === 'boolean') return _normalizeStageVerdict(stage, state, result, receipts, verdict);
  } catch (error) {
    logger.warn('[workflow] stage verifier unavailable; using receipt fallback', { error: error.message });
  }
  const agentSucceeded = state?.status === agentLoop.AgentStatus.SUCCESS;
  return { accepted: Boolean(agentSucceeded && (!stage.needsTools || successful.length)), reason: 'Receipt-based fallback verdict.', receipts };
}

// Run ONE stage as a full agent-loop run. Returns { ok, result }.
async function _runStage(wf, idx) {
  const stage = wf.stages[idx];
  let env = '';
  try { env = await environmentContext.buildEnvironmentBlock(); } catch { env = ''; }
  const goal = [
    'You are executing ONE stage of a larger workflow. Do THIS stage and nothing beyond it.',
    'Use sensible defaults for harmless ambiguity and keep working autonomously.',
    'If a required fact cannot be inferred safely, or a policy/tool requires explicit permission,',
    'ask exactly one concise question. The workflow will checkpoint this stage and route the answer back.',
    `OVERALL WORKFLOW GOAL: ${wf.goal}`,
    _completedSummary(wf, idx),
    _priorProgressBlock(stage),
    _resumeInputBlock(stage),
    `THIS STAGE (${stage.title}): ${stage.goal}`,
    `DONE WHEN: ${stage.doneWhen}`,
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
    localPriority: 'background',
    // Tier 3 #22: read-only workflows (self-initiated proactive investigation) can observe but
    // never write — the agent-loop gate enforces it structurally, so writes stay gated on approval.
    readOnly: !!wf.readOnly,
    preapproved: !!wf.preapproved,
    approvalId: wf.approvalId || null,
    pendingConfirmation: stage.resumeInput?.response
      ? _sanitizePendingConfirmation(stage.pendingConfirmation)
      : null,
    userResponse: stage.resumeInput?.response || null,
    deadlineAt: Date.now() + _stageTimeoutMs(),
    onStep,
  });
  const outcome = _classifyAgentOutcome(state);
  const agentOk = outcome.kind === 'success';
  const result = (state && (state.final_result || state.last_result?.message || state.last_result?.result)) || (agentOk ? 'Completed.' : 'Did not complete.');
  if (outcome.kind === 'waiting_user') {
    return {
      ok: false,
      waitingUser: true,
      question: outcome.question,
      pendingConfirmation: _sanitizePendingConfirmation(state?.current_context?.pending_confirmation),
      result: outcome.question,
      steps: state ? state.step_count : 0,
      verification: null,
    };
  }
  const verification = await _verifyStage(stage, state, result);
  stage.verification = verification;
  const ok = Boolean(agentOk && verification.accepted);
  const resultLimit = Math.max(1000, Number(process.env.AVA_WORKFLOW_RESULT_CHARS) || 6000);
  return { ok, result: String(result).slice(0, resultLimit), steps: state ? state.step_count : 0, verification };
}

// The orchestrator: run pending stages sequentially, checkpointing + replanning. Resumable.
async function run(id) {
  if (_active.has(id)) return;
  _active.add(id);
  try {
    let map = _loadAll();
    let wf = map[id];
    if (!wf) return;
    // A durable user pause only resumes through provideInput(); a generic run/resume must not
    // silently erase the question or misclassify the workflow as complete.
    if (wf.status === 'waiting_user') return;
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
        _announce(`I stopped the workflow "${String(wf.goal).slice(0, 60)}" like you asked.`, wf, 'workflow-aborted');
        return;
      }
      const idx = wf.stages.findIndex(s => s.status === 'pending');
      if (idx === -1) break;  // all stages resolved
      const stage = wf.stages[idx];
      const resumingFromInput = Boolean(stage.resumeInput?.response);
      stage.status = 'running';
      if (!resumingFromInput) stage.attempts = (stage.attempts || 0) + 1;
      stage.startedAt = Date.now();
      wf.currentStage = idx;
      wf.heartbeatAt = Date.now();
      _checkpoint(wf);
      logger.info('[workflow] running stage', { id, stage: idx + 1, title: stage.title, attempt: stage.attempts, interrupted: !!stage.interrupted });

      let res;
      try { res = await _runStage(wf, idx); }
      catch (e) { res = { ok: false, result: e.message }; }

      if (res.waitingUser) {
        const question = String(res.question || 'What information should I use to continue this stage?').slice(0, 1200);
        stage.status = 'waiting_user';
        stage.pendingQuestion = question;
        stage.pendingConfirmation = _sanitizePendingConfirmation(res.pendingConfirmation);
        stage.resumeInput = null;
        stage.error = '';
        wf.status = 'waiting_user';
        wf.currentStage = idx;
        wf.waitingStage = idx;
        wf.pendingQuestion = question;
        wf.log.push({ ts: Date.now(), stage: stage.title, status: 'waiting_user', question, steps: res.steps });
        _checkpoint(wf);
        _announce(`I need your input to continue "${String(wf.goal).slice(0, 60)}": ${question}`, wf, 'workflow-waiting-user');
        return;
      }

      // A supplied answer belongs to one resumed execution only. A later failure should consume
      // the normal retry budget instead of being mistaken for another continuation forever.
      stage.resumeInput = null;
      stage.pendingConfirmation = null;

      if (res.ok) {
        stage.status = 'done'; stage.result = res.result; stage.error = ''; stage.interrupted = false; stage.pendingQuestion = '';
        wf.pendingQuestion = ''; wf.waitingStage = null;
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
        _announce(`I couldn't finish the workflow "${String(wf.goal).slice(0, 60)}" — stage "${stage.title}" kept failing even after replanning.`, wf, 'workflow-failure');
        return;
      }
      const rev = await replan(wf, idx, res.result);
      wf.replans = (wf.replans || 0) + 1;
      if (rev.abandon) {
        wf.status = 'failed'; wf.error = `Abandoned after replanning: ${rev.abandon}`;
        wf.log.push({ ts: Date.now(), stage: 'replan', status: 'abandon', error: rev.abandon });
        _checkpoint(wf);
        _announce(`I had to abandon the workflow "${String(wf.goal).slice(0, 60)}": ${rev.abandon}`, wf, 'workflow-failure');
        return;
      }
      if (!rev.stages || !rev.stages.length) {
        wf.status = 'failed'; wf.error = `Could not revise the plan around: ${res.result}`;
        _checkpoint(wf);
        _announce(`I couldn't finish the workflow "${String(wf.goal).slice(0, 60)}" because I could not build a safe revised plan around the failed stage.`, wf, 'workflow-failure');
        return;
      }
      // Replace the failed stage + everything after it with the revised stages.
      wf.stages = [...wf.stages.slice(0, idx), ...rev.stages.map((s, i) => ({ ...s, n: idx + i + 1 }))];
      wf.log.push({ ts: Date.now(), stage: 'replan', status: 'revised', count: rev.stages.length });
      _checkpoint(wf);
    }

    const failed = wf.stages.some(s => s.status === 'failed');
    wf.status = failed ? 'failed' : 'done';
    wf.pendingQuestion = '';
    wf.waitingStage = null;
    wf.currentStage = wf.stages.length;
    if (!failed) wf.result = wf.stages.map(s => `${s.title}: ${s.result}`).join(' | ').slice(0, 12000);
    _checkpoint(wf);
    logger.info('[workflow] finished', { id, status: wf.status });
    _announce(failed
      ? `The workflow "${String(wf.goal).slice(0, 60)}" finished, but at least one stage failed.`
      : `I finished the whole workflow: ${String(wf.goal).slice(0, 80)}.`,
    wf, failed ? 'workflow-failure' : 'workflow-complete');
  } catch (e) {
    logger.warn('[workflow] run error', { id, error: e.message });
    let failedWorkflow = null;
    try {
      const map = _loadAll();
      if (map[id]) {
        map[id].status = 'failed';
        map[id].error = e.message;
        failedWorkflow = map[id];
        _saveAll(map);
      }
    } catch { /* ignore */ }
    if (failedWorkflow) {
      _announce(`The workflow "${String(failedWorkflow.goal).slice(0, 60)}" failed: ${String(e.message || e).slice(0, 300)}.`, failedWorkflow, 'workflow-failure');
    }
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
  const stages = await planGoal(goal, opts);
  if (!stages.length) return { ok: false, error: "I couldn't break that into a workable plan." };
  const id = 'wf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const wf = { id, goal, status: 'running', stages, currentStage: 0, replans: 0,
    readOnly: !!opts.readOnly, origin: opts.origin || '',
    preapproved: !!opts.preapproved, approvalId: opts.approvalId || null,
    sessionId: opts.sessionId || null,
    acceptanceCriteria: Array.isArray(opts.acceptanceCriteria) ? opts.acceptanceCriteria.slice(0, 20) : [],
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
        _announce(`Heads up — my workflow "${String(wf.goal).slice(0, 60)}" looks stuck on the stage "${st ? st.title : 'unknown'}"; no progress for ${Math.round(age / 60000)} minutes. I'll keep watching, but you may want to check it.`, wf, 'workflow-stuck');
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
      pendingQuestion: w.pendingQuestion || '',
      updatedAt: w.updatedAt,
    }));
}
// Manually resume a paused/incomplete workflow.
function resume(id) {
  const wf = get(id);
  if (!wf) return { ok: false, error: 'not found' };
  if (wf.status === 'done') return { ok: true, status: 'done' };
  if (wf.status === 'failed' || wf.status === 'aborted') {
    return { ok: false, id, status: wf.status, error: `workflow is ${wf.status} and cannot be resumed` };
  }
  if (wf.status === 'waiting_user') {
    return { ok: false, id, status: 'waiting_user', error: 'workflow is waiting for user input', question: wf.pendingQuestion || '' };
  }
  setImmediate(() => run(id).catch(() => {}));
  return { ok: true, id, status: 'resuming' };
}

function provideInput(id, response) {
  const wf = get(id);
  const transition = _applyWorkflowInput(wf, response);
  if (!transition.ok) return transition;
  _checkpoint(wf);
  setImmediate(() => run(id).catch(() => {}));
  return transition;
}

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
        _announce(`I'm picking my workflow "${String(wf.goal).slice(0, 60)}" back up where it left off before the restart.`, wf, 'workflow-resumed');
        setImmediate(() => run(wf.id).catch(() => {}));
      }
    }
  } catch (e) { logger.warn('[workflow] resumeIncomplete failed', { error: e.message }); }
}

export { start, get, list, resume, provideInput, resumeIncomplete, planGoal, abort, startSupervisor };
export default {
  start, get, list, resume, provideInput, resumeIncomplete, planGoal, abort, startSupervisor,
  _internals: {
    _superviseOnce, _priorProgressBlock, _resumeInputBlock, _pendingQuestionFromState,
    _sanitizePendingConfirmation, _pendingConfirmationFromQuestion,
    _classifyAgentOutcome, _applyWorkflowInput, _normalizeStageVerdict,
    _isSubstantiveStageResult, _isReceiptOnlyRejection, _saveAll, _loadAll,
  },
};
