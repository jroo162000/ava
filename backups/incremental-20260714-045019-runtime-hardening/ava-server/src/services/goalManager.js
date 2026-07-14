// Routes long, dependent work into the durable workflow engine and keeps the
// workflow attached to the conversation that created it.
import fs from 'fs';
import path from 'path';
import avaPaths from '../utils/paths.js';
import llmService from './llm.js';
import workflowEngine from './workflowEngine.js';
import capabilityRegistry from './capabilityRegistry.js';
import logger from '../utils/logger.js';
import { emitVoiceEvent } from './voiceBus.js';

const FILE = path.join(avaPaths.dataDir(), 'goal-sessions.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return {}; }
}

function save(state) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const temp = FILE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, FILE);
  } catch (error) { logger.warn('[goals] state save failed', { error: error.message }); }
}

function parseJson(text) {
  try { const match = String(text || '').match(/\{[\s\S]*\}/); return match ? JSON.parse(match[0]) : null; }
  catch { return null; }
}

function linkedWorkflow(sessionId) {
  const link = load()[String(sessionId || 'default')];
  if (!link?.workflowId) return null;
  const workflow = workflowEngine.get(link.workflowId);
  return workflow ? { link, workflow } : null;
}

function statusText(workflow) {
  const done = (workflow.stages || []).filter(stage => stage.status === 'done').length;
  const total = (workflow.stages || []).length;
  const current = workflow.stages?.[workflow.currentStage];
  if (workflow.status === 'done') return `That workflow is complete. ${workflow.result || `${done} of ${total} stages passed verification.`}`;
  if (workflow.status === 'failed') return `That workflow stopped because ${workflow.error || 'a stage could not pass verification'}.`;
  if (workflow.status === 'aborted') return 'That workflow was stopped.';
  if (workflow.status === 'waiting_user') {
    return `That workflow is waiting for your answer before it continues: ${workflow.pendingQuestion || 'What information should I use?'}`;
  }
  return `The workflow is ${workflow.status}: ${done} of ${total} stages are verified${current ? `, and I am on "${current.title}"` : ''}.`;
}

function shouldClassify(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  const words = value.split(/\s+/).length;
  return value.length >= 120 || words >= 22 || /\n/.test(value)
    || /\b(all recommendations|entire (repo|project|system)|full (audit|analysis|report|review)|end[- ]to[- ]end|from start to finish)\b/i.test(value);
}

async function classify(text, { localPriority = 'background' } = {}) {
  const system = [
    'Classify whether a user request needs AVA\'s durable workflow engine.',
    capabilityRegistry.promptBlock(),
    'Use workflow only for several dependent actions, broad investigations, research followed by implementation, work requiring checkpoints, or work likely to outlive one turn.',
    'Use single_action for a bounded action the agent loop can finish now. Use conversation for explanation or ordinary dialogue.',
    'Return JSON only: {"mode":"conversation|single_action|workflow","objective":"durable objective","acceptance_criteria":["observable condition"],"reason":"brief reason"}.',
  ].join('\n');
  try {
    const result = await llmService.chat(
      [{ role: 'system', content: system }, { role: 'user', content: text }],
      { temperature: 0.1, max_tokens: 450, localPriority },
    );
    const parsed = parseJson(result.text || result.content);
    if (['conversation', 'single_action', 'workflow'].includes(parsed?.mode)) return parsed;
  } catch (error) { logger.warn('[goals] classifier failed', { error: error.message }); }
  return { mode: shouldClassify(text) ? 'workflow' : 'single_action', objective: text, acceptance_criteria: [], reason: 'deterministic fallback' };
}

export async function handleTurn(text, { sessionId = 'default', channel = 'text', localPriority = 'background' } = {}) {
  const current = linkedWorkflow(sessionId);
  const value = String(text || '').trim();
  if (current) {
    if (/\b(stop|cancel|abort)\b/i.test(value) && /\b(workflow|task|that|it)\b/i.test(value)) {
      const result = workflowEngine.abort(current.workflow.id);
      return { handled: true, text: result.ok ? 'I stopped that workflow at its next safe boundary.' : `I could not stop it: ${result.error}` };
    }
    if (/\b(status|progress|how .*going|where .* at|what .*working on|finished|done yet)\b/i.test(value)) {
      return { handled: true, text: statusText(current.workflow), workflow: current.workflow };
    }
    if (current.workflow.status === 'waiting_user') {
      const result = workflowEngine.provideInput(current.workflow.id, value);
      const stage = current.workflow.stages?.[current.workflow.currentStage];
      return {
        handled: true,
        text: result.ok
          ? `I recorded your answer and resumed${stage?.title ? ` "${stage.title}"` : ' that workflow'} from its checkpoint.`
          : `I could not apply that answer: ${result.error}`,
        workflow: result,
      };
    }
    if (/\b(resume|continue|pick (it|that) back up)\b/i.test(value)) {
      const result = workflowEngine.resume(current.workflow.id);
      return { handled: true, text: result.ok ? 'I resumed that workflow from its last checkpoint.' : `I could not resume it: ${result.error}` };
    }
  }

  if (!shouldClassify(value)) return { handled: false };
  const decision = await classify(value, { localPriority });
  if (decision.mode !== 'workflow') return { handled: false, decision };
  const objective = String(decision.objective || value).trim();
  const started = await workflowEngine.start(objective, {
    origin: `conversation:${channel}`,
    sessionId,
    acceptanceCriteria: Array.isArray(decision.acceptance_criteria) ? decision.acceptance_criteria : [],
  });
  if (!started.ok) return { handled: false, decision, error: started.error };
  const state = load();
  state[String(sessionId)] = { workflowId: started.id, objective, channel, createdAt: Date.now() };
  save(state);
  emitVoiceEvent('goal.started', { id: started.id, workflowId: started.id, sessionId, objective, acceptanceCriteria: decision.acceptance_criteria || [] }, 'goals');
  return {
    handled: true,
    workflow: started,
    decision,
    text: `I started a durable workflow for that with ${started.stages.length} checkpointed stages. I will verify each stage before I call it complete; workflow ${started.id}.`,
  };
}

export function status(sessionId) {
  const current = linkedWorkflow(sessionId);
  return current ? { ...current, text: statusText(current.workflow) } : null;
}

export default { handleTurn, status };
