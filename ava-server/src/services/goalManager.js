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
import conversationLogger from './conversationLogger.js';

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

const ACTIVE_WORKFLOW_STATES = new Set(['waiting_user', 'running', 'planning']);

function normalizeWorkflowText(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\bwindows\b/g, 'window')
    .replace(/\bwindow options?\b/g, 'window ops')
    .replace(/\bsystem operations?\b/g, 'sys ops')
    .replace(/\bsystem ops\b/g, 'sys ops')
    .replace(/\s+/g, ' ')
    .trim();
}

function isBriefWorkflowAnswer(text = '') {
  const value = normalizeWorkflowText(text);
  return value.split(/\s+/).filter(Boolean).length <= 12
    && /\b(?:yes|no|approve|approved|deny|denied|permission|go ahead|move forward|proceed|continue)\b/.test(value);
}

function workflowLabel(workflow = {}) {
  const goal = normalizeWorkflowText(workflow.goal);
  if (/\bwindow ops\b/.test(goal)) return 'window_ops';
  if (/\bsys ops\b/.test(goal)) return 'sys_ops';
  return String(workflow.goal || workflow.id || 'workflow').slice(0, 54);
}

function goalPromptPrefix(goal = '') {
  return normalizeWorkflowText(goal).split(/\s+/).slice(0, 6).join(' ');
}

function selectWorkflowTargets(text, rows = [], { current = null, lastAssistant = '' } = {}) {
  const value = normalizeWorkflowText(text);
  const all = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const active = all.filter(row => ACTIVE_WORKFLOW_STATES.has(String(row.status || '')));
  const selected = [];
  const add = row => {
    if (row && !selected.some(item => item.id === row.id)) selected.push(row);
  };

  const rawIds = String(text || '').match(/\bwf-[a-z0-9-]+\b/gi) || [];
  for (const id of rawIds) add(all.find(row => String(row.id).toLowerCase() === id.toLowerCase()));

  if (/\bwindow ops\b/.test(value)) {
    const matches = active.filter(row => /\bwindow ops\b/.test(normalizeWorkflowText(row.goal)));
    const fallback = all.filter(row => /\bwindow ops\b/.test(normalizeWorkflowText(row.goal)))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 1);
    for (const row of matches.length ? matches : fallback) add(row);
  }
  if (/\bsys ops\b/.test(value)) {
    const matches = active.filter(row => /\bsys ops\b/.test(normalizeWorkflowText(row.goal)));
    const fallback = all.filter(row => /\bsys ops\b/.test(normalizeWorkflowText(row.goal)))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 1);
    for (const row of matches.length ? matches : fallback) add(row);
  }
  if (selected.length) return selected;

  const namesGroup = /\b(?:both|all)\s+(?:(?:current|active|waiting)\s+)?workflows?\b/.test(value)
    || /\bworkflows?\b[\s\S]{0,24}\b(?:both|all)\b/.test(value);
  const namesActiveSet = /\b(?:current|active|waiting)\s+workflows?\b/.test(value)
    || /\bworkflows?\b[\s\S]{0,24}\b(?:active|waiting)\b/.test(value);
  if (namesGroup || namesActiveSet) return active;

  if (isBriefWorkflowAnswer(value) && lastAssistant) {
    const prior = normalizeWorkflowText(lastAssistant);
    const waiting = active.filter(row => row.status === 'waiting_user');
    if (/\b(?:need your input to continue|waiting for your answer|approve this exact action)\b/.test(prior)) {
      const byGoal = waiting.filter(row => {
        const prefix = goalPromptPrefix(row.goal);
        return prefix && prior.includes(prefix);
      });
      if (byGoal.length) return byGoal.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 1);

      const byQuestion = waiting.filter(row => {
        const question = normalizeWorkflowText(row.pendingQuestion);
        return question && prior.includes(question);
      });
      if (byQuestion.length) return byQuestion.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 1);
    }
  }

  if (/\bworkflows?\b/.test(value) && current?.workflow) return [current.workflow];
  return [];
}

function lastAssistantText() {
  try {
    const recent = conversationLogger.getRecentHistoryAcrossDays(20) || [];
    for (let index = recent.length - 1; index >= 0; index--) {
      const entry = recent[index];
      if (entry && (entry.direction || entry.role) === 'assistant') return String(entry.content || entry.text || '');
    }
  } catch { /* conversation context is optional */ }
  return '';
}

function formatWorkflowStatus(workflows = []) {
  if (!workflows.length) return 'There are no active or waiting workflows right now.';
  const lines = workflows.map(workflow => {
    const label = workflowLabel(workflow);
    const stage = workflow.currentStage ? ` on "${workflow.currentStage}"` : '';
    const waiting = workflow.status === 'waiting_user' && workflow.pendingQuestion
      ? ` Waiting for: ${workflow.pendingQuestion}`
      : '';
    return `- ${label} (${workflow.id}): ${workflow.status}${stage}.${waiting}`;
  });
  return `Current workflows:\n${lines.join('\n')}`;
}

function handleReferencedWorkflowTurn(value, { current = null, sessionId = 'default' } = {}) {
  const normalized = normalizeWorkflowText(value);
  const briefAnswer = isBriefWorkflowAnswer(normalized);
  const lastAssistant = briefAnswer ? lastAssistantText() : '';
  const mentionsWorkflow = /\bworkflows?\b/.test(normalized);
  const mentionsNamedWorkflow = /\b(?:window ops|sys ops)\b/.test(normalized);
  const promptReply = briefAnswer
    && /\b(?:need your input to continue|waiting for your answer|approve this exact action)\b/.test(normalizeWorkflowText(lastAssistant));
  if (!mentionsWorkflow && !mentionsNamedWorkflow && !promptReply) return { handled: false };

  const rows = workflowEngine.list();
  const targets = selectWorkflowTargets(value, rows, { current, lastAssistant });
  const asksStatus = /\b(?:status|progress|update|active|current|waiting|how .*going|where .* at|what .*working on)\b/.test(normalized);
  if (!targets.length) {
    return asksStatus || mentionsWorkflow
      ? { handled: true, text: 'I could not find an active workflow matching that description.' }
      : { handled: false };
  }

  const negatesContinuation = /\b(?:can'?t|cannot|do not|don't|not)\s+(?:continue|resume|proceed)\b/.test(normalized);
  const stops = /\b(?:stop|cancel|abort)\b/.test(normalized);
  const advances = !negatesContinuation && (briefAnswer
    || /\b(?:approve|approved|permission|go ahead|move forward|proceed|continue|resume|finish)\b/.test(normalized));

  if (stops) {
    const results = targets.map(workflow => ({ workflow, result: workflowEngine.abort(workflow.id) }));
    const failed = results.filter(item => !item.result.ok);
    return {
      handled: true,
      text: failed.length
        ? `I could not stop ${failed.map(item => workflowLabel(item.workflow)).join(' and ')}: ${failed.map(item => item.result.error).join('; ')}.`
        : `I stopped ${results.map(item => workflowLabel(item.workflow)).join(' and ')} at their next safe boundaries.`,
      workflows: results.map(item => item.result),
    };
  }

  if (advances) {
    const results = targets.map(workflow => {
      const result = workflow.status === 'waiting_user'
        ? workflowEngine.provideInput(workflow.id, value)
        : workflowEngine.resume(workflow.id);
      return { workflow, result };
    });
    const successful = results.filter(item => item.result.ok);
    const failed = results.filter(item => !item.result.ok);
    if (successful.length) {
      const state = load();
      const item = successful[0].workflow;
      state[String(sessionId)] = {
        workflowId: item.id,
        workflowIds: successful.map(entry => entry.workflow.id),
        objective: item.goal,
        channel: 'workflow-control',
        createdAt: Date.now(),
      };
      save(state);
    }
    const resumed = successful.map(item => workflowLabel(item.workflow)).join(' and ');
    const failureText = failed.length
      ? ` I could not resume ${failed.map(item => workflowLabel(item.workflow)).join(' and ')}: ${failed.map(item => item.result.error).join('; ')}.`
      : '';
    return {
      handled: true,
      text: successful.length
        ? `I recorded your answer and resumed ${resumed} from ${successful.length === 1 ? 'its' : 'their'} waiting checkpoint${successful.length === 1 ? '' : 's'}.${failureText}`
        : failureText.trim(),
      workflow: successful.length === 1 ? workflowEngine.get(successful[0].workflow.id) : null,
      workflows: results.map(item => item.result),
    };
  }

  return { handled: true, text: formatWorkflowStatus(targets), workflows: targets };
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

function isConversationOnly(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  const asksForDialogue = /\b(?:what do you think|what are your thoughts|how do you feel|how .* feel|tell me what you think|tell me about|talk (?:to me )?about|explain|describe|reflect (?:on|about)|give me your (?:thoughts|opinion|take))\b/.test(value);
  if (!asksForDialogue) return false;
  const workVerb = '(?:audit|browse|build|change|check|create|delete|deploy|diagnose|download|edit|find|fix|implement|inspect|install|look up|modify|open|post|read|research|restart|review|run|send|test|update|verify|write)';
  const asksForWork = new RegExp(`^(?:please\\s+)?${workVerb}\\b`).test(value)
    || new RegExp(`\\b(?:then|and then|and|also|please|can you|could you|would you|i need you to|i want you to)\\s+${workVerb}\\b`).test(value);
  return !asksForWork;
}

function shouldClassify(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (isConversationOnly(value)) return false;
  const words = value.split(/\s+/).length;
  const actionCount = (value.match(/\b(?:audit|browse|build|change|check|create|delete|deploy|diagnose|download|edit|find|fix|implement|inspect|install|look up|modify|open|post|read|research|restart|review|send|test|update|verify|write)\b/gi) || []).length;
  return value.length >= 120 || words >= 22 || /\n/.test(value)
    || actionCount >= 2
    || /\b(all recommendations|entire (repo|project|system)|full (audit|analysis|report|review)|end[- ]to[- ]end|from start to finish)\b/i.test(value);
}

async function classify(text, { localPriority = 'background' } = {}) {
  const system = [
    'Classify whether a user request needs AVA\'s durable workflow engine.',
    capabilityRegistry.promptBlock(),
    'Use workflow only for several dependent actions, broad investigations, research followed by implementation, work requiring checkpoints, or work likely to outlive one turn.',
    'Use single_action for a bounded action the agent loop can finish now. Use conversation for explanation, reflection, opinions, discussion of completed work, or ordinary dialogue. Length alone never makes dialogue a workflow.',
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
  const referenced = handleReferencedWorkflowTurn(value, { current, sessionId });
  if (referenced.handled) return referenced;
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

export default {
  handleTurn,
  status,
  _internals: {
    isConversationOnly,
    shouldClassify,
    normalizeWorkflowText,
    selectWorkflowTargets,
    formatWorkflowStatus,
    handleReferencedWorkflowTurn,
  },
};
