// subagentOrchestrator.js — AVA as the LEAD AGENT. She decomposes a goal into independent subtasks,
// spawns each as its OWN agent-loop run (a subagent) running CONCURRENTLY (bounded), collects their
// results, and synthesizes a final answer. Each subagent has the full tool set but canDelegate=false
// so only the lead delegates (no runaway recursion). Reuses agentLoop.runAgentLoop.
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import llmService from './llm.js';
import agentLoop from './agentLoop.js';
import environmentContext from './environmentContext.js';
import subagentRoles from './subagentRoles.js';

const FILE = path.join(process.cwd(), 'data', 'orchestrations.json');
const MAX_SUBAGENTS = parseInt(process.env.AVA_MAX_SUBAGENTS || '6', 10);
const CONCURRENCY = parseInt(process.env.AVA_SUBAGENT_CONCURRENCY || '4', 10);
const SUBAGENT_STEP_LIMIT = parseInt(process.env.AVA_SUBAGENT_STEPS || '12', 10);
const _ring = [];

function _persist(rec) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    let all = [];
    try { if (fs.existsSync(FILE)) all = JSON.parse(fs.readFileSync(FILE, 'utf8')) || []; } catch { /* ignore */ }
    all.push(rec);
    if (all.length > 50) all = all.slice(-50);
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  } catch (e) { try { logger.warn('[subagents] persist failed', { error: e.message }); } catch { /* ignore */ } }
}

function _parseLoose(t) {
  const s = String(t || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function _normalizeSubs(arr) {
  return (Array.isArray(arr) ? arr : []).filter(s => s && (s.goal || typeof s === 'string')).slice(0, MAX_SUBAGENTS)
    .map((s, i) => (typeof s === 'string'
      ? { role: 'general', goal: s.slice(0, 800) }
      : { role: subagentRoles.getRole(s.role).name, goal: String(s.goal).slice(0, 800) }));
}

// LEAD plans the subtasks (each a subagent's goal + role) when not given explicitly.
async function planSubtasks(goal) {
  const sys = [
    'You are AVA, the LEAD agent. Break the GOAL into INDEPENDENT subtasks that separate subagents can run IN PARALLEL.',
    'Assign each subtask the best-fitting ROLE from this list — each role has its OWN SCOPED toolset:',
    subagentRoles.rolesForPrompt(),
    "A subagent only gets its role's tools, so pick the role that matches the work; use \"general\" when it spans many categories.",
    'Split ONLY into truly independent, parallelizable pieces. If the goal is a single coherent task, return ONE subtask.',
    'Use 1-6 subtasks. Output STRICT JSON only: {"subtasks":[{"role":"<role name from the list>","goal":"<one concrete instruction for that subagent>"}]}',
  ].join('\n');
  try {
    const r = await llmService.chat([{ role: 'system', content: sys }, { role: 'user', content: `GOAL: ${goal}` }], { temperature: 0.3, max_tokens: 900 });
    return _normalizeSubs((_parseLoose(r.text || r.content || '') || {}).subtasks);
  } catch (e) { logger.warn('[subagents] planSubtasks failed', { error: e.message }); return []; }
}

// Run ONE subagent: a full agent-loop run with its own goal + role. canDelegate=false (no recursion).
async function runSubagent(sub, sharedCtx) {
  let env = '';
  try { env = await environmentContext.buildEnvironmentBlock(); } catch { env = ''; }
  const roleDef = subagentRoles.getRole(sub.role);
  const goal = [
    roleDef.prompt,  // role's specialized instructions (Claude-SDK style)
    `You are a SUBAGENT (role: ${roleDef.name}) working under AVA, the lead agent. Do ONLY your assigned task, use your (scoped) tools as needed, and report a clear, complete result.`,
    sharedCtx ? `SHARED CONTEXT: ${sharedCtx}` : '',
    `YOUR TASK: ${sub.goal}`,
  ].filter(Boolean).join('\n');
  const state = await agentLoop.runAgentLoop(goal, {
    multiStep: true, runTools: true, stepLimit: SUBAGENT_STEP_LIMIT, environment: env,
    source: 'subagent', canDelegate: false, role: roleDef.name, allowedTools: roleDef.allow,
  });
  const ok = state && state.status === agentLoop.AgentStatus.SUCCESS;
  return {
    role: roleDef.name, goal: sub.goal, status: ok ? 'done' : 'failed',
    result: String((state && (state.final_result || (state.last_result && state.last_result.message))) || '').slice(0, 1200),
    steps: state ? state.step_count : 0,
  };
}

// Run subagents with bounded concurrency.
async function _runAll(subs, sharedCtx) {
  const results = [];
  let i = 0;
  async function worker() { while (i < subs.length) { const idx = i++; results[idx] = await runSubagent(subs[idx], sharedCtx); } }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, subs.length) }, worker));
  return results;
}

// LEAD synthesizes the subagent results into one final answer for the original goal.
async function synthesize(goal, results) {
  const sys = 'You are AVA, the LEAD agent. Your subagents each completed a piece of the work. Synthesize their results into ONE clear, complete answer to the ORIGINAL GOAL, calling out anything that failed. Be direct and specific.';
  const user = `ORIGINAL GOAL: ${goal}\n\nSUBAGENT RESULTS:\n` + results.map((r, i) => `#${i + 1} [${r.role}] (${r.status}): ${r.result}`).join('\n\n');
  try {
    const r = await llmService.chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0.4, max_tokens: 1500 });
    return String(r.text || r.content || '').trim() || results.map(r => `[${r.role}] ${r.result}`).join('\n');
  } catch { return results.map(r => `[${r.role}] ${r.result}`).join('\n'); }
}

// MAIN: AVA leads — plan (if needed) -> spawn subagents (parallel, bounded) -> collect -> synthesize.
async function orchestrate({ goal, subtasks, sharedContext, synthesize: doSynth = true } = {}) {
  const id = 'orch-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5);
  let subs = (Array.isArray(subtasks) && subtasks.length) ? _normalizeSubs(subtasks) : await planSubtasks(String(goal || ''));
  if (!subs.length) return { ok: false, id, error: "I couldn't break that into subtasks to delegate." };
  logger.info('[subagents] lead spawning subagents', { id, count: subs.length, roles: subs.map(s => s.role) });
  const t0 = Date.now();
  const results = await _runAll(subs, sharedContext);
  const synthesis = doSynth ? await synthesize(String(goal || ''), results) : '';
  const rec = { id, goal: String(goal || ''), createdAt: new Date().toISOString(), ms: Date.now() - t0, subagents: results, synthesis };
  _ring.push({ id, goal: rec.goal, count: results.length, at: rec.createdAt });
  if (_ring.length > 50) _ring.shift();
  _persist(rec);
  logger.info('[subagents] orchestration done', { id, subagents: results.length, ms: rec.ms });
  return { ok: true, ...rec };
}

function recent(n = 10) { return _ring.slice(-Math.max(1, n)); }

export { orchestrate, runSubagent, planSubtasks, synthesize, recent };
export default { orchestrate, runSubagent, planSubtasks, synthesize, recent };
