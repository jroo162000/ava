// workflowEngine.js — long-horizon, RESUMABLE workflow autonomy for AVA.
//
// Where the single agent loop (agentLoop.js) handles a bounded multi-step task, this engine handles
// a LONG goal: it (1) PLANS the goal into ordered STAGES, (2) runs each stage as a full agent-loop
// run, (3) CHECKPOINTS progress to disk after every stage so a restart resumes where it left off,
// and (4) REPLANS the remaining stages when one fails, routing around the failure to still reach the
// goal. This is the durable plan + replanning layer that mature long-running agent frameworks have.
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import llmService from './llm.js';
import agentLoop from './agentLoop.js';
import environmentContext from './environmentContext.js';

const FILE = path.join(process.cwd(), 'data', 'workflows.json');
const MAX_STORED = 50;
const MAX_STAGE_ATTEMPTS = 2;     // retry a failed stage once before replanning
const MAX_REPLANS = 3;            // give up after this many plan revisions
const STAGE_STEP_LIMIT = parseInt(process.env.AVA_WORKFLOW_STAGE_STEPS || '14', 10);

const _active = new Set();        // workflow ids currently executing (no double-run)

function _ensureDir() { try { const d = path.dirname(FILE); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ } }
function _loadAll() {
  try { if (fs.existsSync(FILE)) { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (j && typeof j === 'object') return j; } } catch { /* ignore */ }
  return {};
}
function _saveAll(map) {
  try {
    _ensureDir();
    const ids = Object.keys(map).sort((a, b) => (map[b].updatedAt || 0) - (map[a].updatedAt || 0)).slice(0, MAX_STORED);
    const trimmed = {}; for (const id of ids) trimmed[id] = map[id];
    fs.writeFileSync(FILE, JSON.stringify(trimmed, null, 2));
  } catch (e) { try { logger.warn('[workflow] save failed', { error: e.message }); } catch { /* ignore */ } }
}
// Checkpoint a single workflow (merge into the on-disk map). This is what makes it resumable.
function _checkpoint(wf) {
  wf.updatedAt = Date.now();
  const map = _loadAll();
  map[wf.id] = wf;
  _saveAll(map);
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
      .map((s, i) => ({ n: i + 1, title: String(s.title || `Stage ${i + 1}`).slice(0, 120), goal: String(s.goal).slice(0, 1000), status: 'pending', attempts: 0, result: '', error: '' }));
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
      .map((s, i) => ({ n: failedIdx + i + 1, title: String(s.title || `Stage ${failedIdx + i + 1}`).slice(0, 120), goal: String(s.goal).slice(0, 1000), status: 'pending', attempts: 0, result: '', error: '' }));
    return { stages };
  } catch (e) { logger.warn('[workflow] replan failed', { error: e.message }); return { stages: [] }; }
}

function _completedSummary(wf, upto) {
  const lines = wf.stages.slice(0, upto).filter(s => s.status === 'done')
    .map(s => `- ${s.title}: ${String(s.result || '').slice(0, 180)}`);
  return lines.length ? `Stages already completed in this workflow:\n${lines.join('\n')}\n` : '';
}

// Run ONE stage as a full agent-loop run. Returns { ok, result }.
async function _runStage(wf, idx) {
  const stage = wf.stages[idx];
  let env = '';
  try { env = await environmentContext.buildEnvironmentBlock(); } catch { env = ''; }
  const goal = [
    'You are executing ONE stage of a larger workflow. Do THIS stage and nothing beyond it.',
    `OVERALL WORKFLOW GOAL: ${wf.goal}`,
    _completedSummary(wf, idx),
    `THIS STAGE (${stage.title}): ${stage.goal}`,
  ].filter(Boolean).join('\n');
  const state = await agentLoop.runAgentLoop(goal, { multiStep: true, runTools: true, stepLimit: STAGE_STEP_LIMIT, environment: env, source: 'workflow' });
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
    // Reset any stage left mid-flight by a restart.
    wf.stages.forEach(s => { if (s.status === 'running') s.status = 'pending'; });
    _checkpoint(wf);

    while (true) {
      const idx = wf.stages.findIndex(s => s.status === 'pending');
      if (idx === -1) break;  // all stages resolved
      const stage = wf.stages[idx];
      stage.status = 'running'; stage.attempts = (stage.attempts || 0) + 1;
      wf.currentStage = idx; _checkpoint(wf);
      logger.info('[workflow] running stage', { id, stage: idx + 1, title: stage.title, attempt: stage.attempts });

      let res;
      try { res = await _runStage(wf, idx); }
      catch (e) { res = { ok: false, result: e.message }; }

      if (res.ok) {
        stage.status = 'done'; stage.result = res.result; stage.error = '';
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
        return;
      }
      const rev = await replan(wf, idx, res.result);
      wf.replans = (wf.replans || 0) + 1;
      if (rev.abandon) {
        wf.status = 'failed'; wf.error = `Abandoned after replanning: ${rev.abandon}`;
        wf.log.push({ ts: Date.now(), stage: 'replan', status: 'abandon', error: rev.abandon });
        _checkpoint(wf);
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
  } catch (e) {
    logger.warn('[workflow] run error', { id, error: e.message });
    try { const map = _loadAll(); if (map[id]) { map[id].status = 'failed'; map[id].error = e.message; _saveAll(map); } } catch { /* ignore */ }
  } finally {
    _active.delete(id);
  }
}

// Plan a goal into stages and START running it in the background. Returns the planned workflow.
async function start(goal) {
  goal = String(goal || '').trim();
  if (!goal) return { ok: false, error: 'no goal' };
  const stages = await planGoal(goal);
  if (!stages.length) return { ok: false, error: "I couldn't break that into a workable plan." };
  const id = 'wf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const wf = { id, goal, status: 'running', stages, currentStage: 0, replans: 0, createdAt: Date.now(), updatedAt: Date.now(), log: [], result: '', error: '' };
  _checkpoint(wf);
  setImmediate(() => run(id).catch(() => {}));  // run in the background; caller gets the plan now
  return { ok: true, id, goal, stages: stages.map(s => ({ n: s.n, title: s.title, goal: s.goal, status: s.status })) };
}

function get(id) { const wf = _loadAll()[id]; return wf || null; }
function list() {
  const map = _loadAll();
  return Object.values(map).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(w => ({ id: w.id, goal: w.goal, status: w.status, stages: w.stages.length, done: w.stages.filter(s => s.status === 'done').length, updatedAt: w.updatedAt }));
}
// Manually resume a paused/incomplete workflow.
function resume(id) { const wf = get(id); if (!wf) return { ok: false, error: 'not found' }; if (wf.status === 'done') return { ok: true, status: 'done' }; setImmediate(() => run(id).catch(() => {})); return { ok: true, id, status: 'resuming' }; }

// On server startup, resume any workflow that was mid-run when we last stopped.
function resumeIncomplete() {
  try {
    const map = _loadAll();
    for (const wf of Object.values(map)) {
      if (wf.status === 'running' || wf.status === 'planning') {
        logger.info('[workflow] resuming after restart', { id: wf.id, goal: String(wf.goal).slice(0, 80) });
        setImmediate(() => run(wf.id).catch(() => {}));
      }
    }
  } catch (e) { logger.warn('[workflow] resumeIncomplete failed', { error: e.message }); }
}

export { start, get, list, resume, resumeIncomplete, planGoal };
export default { start, get, list, resume, resumeIncomplete, planGoal };
