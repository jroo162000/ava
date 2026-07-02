// Agent Loop Service - Unified Control Loop
// Phase 4: All tasks run through Observe → Decide → Act → Record → Loop
// Phase 5: Just-in-time memory injection for decisions
//
// This is the authoritative agent loop that:
// - Maintains state across steps
// - Calls LLM to decide next action
// - Executes tools and captures results
// - Records history for replay
// - Handles recovery from failures

import logger from '../utils/logger.js';
import config from '../utils/config.js';
import toolsService from './tools.js';
import subagentRoles from './subagentRoles.js';
import autonomyLib from './autonomyPolicy.js';
import memoryService, { MemoryType, MemorySource } from './memoryHub.js';  // Tier 1 #5: one memory interface
import curiosity from './curiositySupervisor.js';
import digestQueue from './digestQueue.js';
import { jaccardSim } from './curiosityScoring.js';
import llmService from './llm.js';
import moltbookScheduler from './moltbookScheduler.js';
import persona from './persona.js';
import curatedMemory from './curatedMemory.js';
import skillStore from './skillStore.js';
import trainingGuidance from './trainingGuidance.js';
import modelConfig from '../utils/modelConfig.js';
import { emitVoiceEvent } from './voiceBus.js';  // Tier 2 #15: explicit working-state events for the UI

// Informational tools whose raw result should be SYNTHESIZED into a real answer (her own knowledge
// + the findings) rather than returned verbatim -- otherwise a lookup shortens/replaces her answer.
const INFO_TOOLS = new Set(['web_search', 'web_scrape', 'memory_search', 'finance_search', 'net_ops']);
async function synthesizeAnswer(goal, tool, result) {
  try {
    const r = (result && (result.result || result)) || {};
    let found = '';
    if (Array.isArray(r.results)) found = r.results.map((x, i) => `(${i + 1}) ${x.title || ''} - ${x.snippet || x.text || ''} [${x.url || x.href || ''}]`).join('\n');
    else if (Array.isArray(r.matches)) found = r.matches.map((x, i) => `(${i + 1}) ${x.text || x.snippet || ''}`).join('\n');
    else found = String(r.text || r.content || r.abstract || r.message || '').slice(0, 6000);
    if (!found.trim()) return '';
    const sys = 'You are AVA answering the user. You just looked something up; the findings are below. Write a COMPLETE, genuinely helpful answer in your own natural voice, SYNTHESIZING what you already know WITH these findings. Do not just repeat the search results, and do not shorten your answer merely because you searched -- be as thorough as the question deserves. If the findings are thin or conflict with what you know, say what is reliable. Do not mechanically say "the search results say".';
    const usr = `The user asked: ${String(goal || '')}\n\nWhat you found (${tool}):\n${found}`;
    const resp = await llmService.chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { temperature: 0.5, max_tokens: 1200 });
    return String((resp && (resp.text || resp.content)) || '').trim();
  } catch (e) { logger.warn('[agent] synthesis failed', { error: e.message }); return ''; }
}
import skillCapture from './skillCapture.js';
import lessonLearner from './lessonLearner.js';

// Agent state constants
const DEFAULT_STEP_LIMIT = 12;
const MAX_STEP_LIMIT = 25;
const MAX_CONSECUTIVE_ERRORS = 3;

/**
 * Decision types returned by LLM
 */
const DecisionType = {
  TOOL_CALL: 'tool_call',
  PARALLEL: 'parallel',     // run several INDEPENDENT read-only tool_calls concurrently
  DELEGATE: 'delegate',     // LEAD: spawn subagents (each its own loop) for independent subtasks
  ASK_USER: 'ask_user',
  STOP: 'stop'
};

// Subagent role tool-scoping: a pattern is an exact tool name or a trailing-'*' wildcard ("fs_*").
function _toolMatch(name, pattern) {
  name = String(name || ''); pattern = String(pattern || '');
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}
// Is a tool permitted for this (possibly role-scoped) agent? Lead/general agents allow everything.
function _toolAllowed(state, toolName) {
  if (Array.isArray(state.allowedTools) && state.allowedTools.length && !state.allowedTools.some(p => _toolMatch(toolName, p))) return false;
  if (Array.isArray(state.deniedTools) && state.deniedTools.length && state.deniedTools.some(p => _toolMatch(toolName, p))) return false;
  return true;
}

function extractFirstJsonObject(text = '') {
  const s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const src = fence ? fence[1] : s;
  const start = src.indexOf('{');
  if (start < 0) return src;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

function escapeInvalidJsonBackslashes(text = '') {
  return String(text || '').replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
}

// Repair a JSON object that was cut off mid-output (the model hit the token limit while writing
// a long string/reasoning field) — close any open string and any open braces/brackets so the
// already-emitted fields (decision/tool/args, which come first) can still be parsed. This is what
// caused the recurring "Unterminated string in JSON at position N" crashes in the decide step.
function repairTruncatedJson(src = '') {
  let s = String(src || '');
  const start = s.indexOf('{');
  if (start < 0) return s;
  s = s.slice(start);
  let inStr = false, esc = false;
  const stack = [];
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    out += ch;
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (esc) out += '\\';          // a trailing lone backslash would break the closing quote
  if (inStr) out += '"';         // close an unterminated string
  out = out.replace(/,\s*$/, ''); // drop a dangling comma left by truncation
  while (stack.length) out += stack.pop();  // close open braces/brackets in order
  return out;
}

function parseDecisionJson(text = '') {
  const jsonStr = extractFirstJsonObject(text);
  const attempts = [
    jsonStr,
    escapeInvalidJsonBackslashes(jsonStr),
    repairTruncatedJson(jsonStr),
    repairTruncatedJson(escapeInvalidJsonBackslashes(jsonStr)),
  ];
  let firstError = null;
  for (const candidate of attempts) {
    try { return JSON.parse(candidate); }
    catch (e) { if (!firstError) firstError = e; }
  }
  throw firstError;
}

/**
 * Agent execution status
 */
const AgentStatus = {
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
  WAITING_USER: 'waiting_user',
  STEP_LIMIT: 'step_limit'
};

/**
 * Create initial agent state
 */
// A goal is "multi-step" only if it clearly chains actions ("and then", "also", or
// two different action verbs). Single-action goals stop after one successful tool so
// the loop doesn't tack on extra unrequested actions (e.g. take screenshot THEN open).
function isMultiStepGoal(goal) {
  const g = String(goal || '').toLowerCase();
  if (/\b(and then|then\b|after that|also\b|, and|and also)\b/.test(g)) return true;
  const verbs = g.match(/\b(take|open|send|reply|create|make|find|search|read|write|save|delete|remove|cancel|update|change|move|copy|rename|turn|set|close|launch|show|play|record|capture|schedule|book|add|post|download|upload)\b/g) || [];
  return new Set(verbs).size > 1;
}

function createAgentState(goal, options = {}) {
  return {
    _multiStep: options.multiStep !== undefined ? !!options.multiStep : isMultiStepGoal(goal),
    id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    goal,
    status: AgentStatus.RUNNING,
    step_count: 0,
    step_limit: Math.min(options.stepLimit || DEFAULT_STEP_LIMIT, MAX_STEP_LIMIT),
    runTools: options.runTools !== false,  // default true; false skips tool execution
    // Tier 3 #22: READ-ONLY execution — a HARD, prompt-independent guarantee that this run can
    // observe (read/scan/enumerate/search) but can NEVER write, send, delete, execute, or take
    // any confirm-gated/high-risk/destructive action. Used by self-initiated proactive
    // investigation so writes STAY behind the user's approval; enforced at the act() gate.
    readOnly: !!options.readOnly,
    canDelegate: options.canDelegate !== false,  // LEAD may spawn subagents; subagents get false (no recursion)
    allowedTools: options.allowedTools || null,  // subagent ROLE tool scoping (allowlist of names/'*' patterns)
    deniedTools: options.deniedTools || null,    // optional denylist
    role: options.role || null,                  // subagent role name (for logging/observability)
    last_action: null,
    last_result: null,
    errors: [],
    consecutive_errors: 0,
    current_context: {
      memories: [],
      system_info: {},
      user_info: options.userInfo || {},
      user_response: null,
      pending_confirmation: null
    },
    toolset: [],
    history: [],
    recentHistory: options.recentHistory || [],  // recent conversation turns for context
    recentArtifacts: options.recentArtifacts || [],  // exact paths/ids from recent turns
    environment: options.environment || '',  // live OS-awareness block (foreground window, CPU/RAM, recent actions)
    memoryFilter: options.memoryFilter || null,
    eventSource: options.source || '',  // tags tool events for the live UI (e.g. 'voice')
    // Tier 2 #14 long-horizon hooks (both optional; absent = identical behavior to before):
    deadline_at: Number(options.deadlineAt) > 0 ? Number(options.deadlineAt) : 0,  // epoch ms wall-clock budget
    started_at_ms: Date.now(),
    onStep: typeof options.onStep === 'function' ? options.onStep : null,  // per-step heartbeat/progress callback
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    final_result: null
  };
}

/**
 * OBSERVE: Gather context for decision making
 * Phase 5: Just-in-time memory injection
 */
async function observe(state) {
  logger.info('[agent] Observe', { step: state.step_count, goal: state.goal.slice(0, 50) });
  
  const observations = {
    timestamp: new Date().toISOString(),
    step: state.step_count
  };

  // 1. Get available tools
  try {
    state.toolset = await toolsService.getAllTools();
    // ROLE SCOPING: a role-scoped subagent only SEES its allowed tools (so the model can't pick
    // out-of-scope tools), in addition to the hard block enforced at execution time.
    if ((Array.isArray(state.allowedTools) && state.allowedTools.length) || (Array.isArray(state.deniedTools) && state.deniedTools.length)) {
      state.toolset = state.toolset.filter(t => _toolAllowed(state, t.name));
    }
    observations.tools_available = state.toolset.length;
  } catch (e) {
    logger.warn('[agent] Failed to get tools', { error: e.message });
    observations.tools_error = e.message;
  }

  // 2. Phase 5: Just-in-time memory retrieval with filters
  try {
    const retrievalQuery = memoryService.buildRetrievalQuery(
      state.goal,
      state.last_action,
      state.last_result
    );

    // Only inject DURABLE context (preferences, constraints, facts) into decisions.
    // We deliberately exclude WORKFLOW / AGENT_ACTION / WARNING: feeding "you already
    // completed this task" or "you successfully used calendar_ops" made her STOP and
    // claim success without actually performing the current request. Each request must
    // be executed fresh.
    const memoryTypes = state.memoryFilter === 'facts_only'
      ? [MemoryType.FACT, MemoryType.PREFERENCE, MemoryType.CONSTRAINT]
      : [MemoryType.PREFERENCE, MemoryType.CONSTRAINT, MemoryType.FACT];

    if (state.memoryFilter === 'facts_only') {
      logger.info('[agent] Memory filter: facts_only (validation mode — no workflows/warnings/agent_actions)');
    }

    const memories = await memoryService.retrieveRelevant(retrievalQuery, 8, {
      minPriority: 2,
      types: memoryTypes
    });
    
    state.current_context.memories = memories || [];
    observations.memories_found = state.current_context.memories.length;
    observations.memory_prompt = memoryService.formatForPrompt(memories);
    
    logger.info('[agent] Memory retrieved', {
      query: retrievalQuery.slice(0, 60),
      count: memories.length,
      types: [...new Set(memories.map(m => m.type))]
    });
  } catch (e) {
    logger.warn('[agent] Failed to retrieve memories', { error: e.message });
    observations.memory_error = e.message;
    observations.memory_prompt = '';
  }

  // 3. Get system info
  state.current_context.system_info = {
    platform: process.platform,
    node_version: process.version,
    uptime: process.uptime(),
    memory_usage: process.memoryUsage().heapUsed
  };

  // 4. Include last action/result context
  if (state.last_action) {
    observations.last_action = state.last_action;
    observations.last_result = state.last_result;
  }

  // 5. Include error context
  if (state.errors.length > 0) {
    observations.recent_errors = state.errors.slice(-3);
  }

  // 6. Include user response
  if (state.current_context.user_response) {
    observations.user_response = state.current_context.user_response;
  }

  // 7. Include pending confirmation
  if (state.current_context.pending_confirmation) {
    observations.pending_confirmation = state.current_context.pending_confirmation;
  }

  return observations;
}

/**
 * Build the prompt for the LLM decision
 * Phase 5: Uses formatted memory from observations
 */
function buildDecisionPrompt(state, observations, native = false) {
  const toolDescriptions = native ? '' : state.toolset.map(t => {
    // Surface each tool's valid actions so the model uses real action names instead
    // of guessing (e.g. calendar_ops "get_today", not an invented "check_today").
    let actionsHint = '';
    try {
      const props = t.schema && t.schema.properties;
      const enumVals = props && ((props.action && props.action.enum) || (props.operation && props.operation.enum));
      if (Array.isArray(enumVals) && enumVals.length) actionsHint = ` — set args.action to one of: ${enumVals.join(', ')}`;
    } catch (e) { /* no schema */ }
    return `- ${t.name}: ${t.description}${actionsHint}${t.requires_confirm ? ' [REQUIRES confirmed:true]' : ''}${t.risk_level === 'high' ? ' [HIGH RISK]' : ''}`;
  }).join('\n');

  const memoryContext = observations.memory_prompt || '';

  const historyContext = state.history.length > 0
    ? `\nPrevious steps:\n${state.history.slice(-5).map((h, i) => 
        `${i + 1}. Action: ${h.action?.tool || h.action?.type || 'unknown'} → Result: ${h.result?.status || 'unknown'}${h.result?.message ? ` (${h.result.message})` : ''}`
      ).join('\n')}`
    : '';

  const errorContext = state.errors.length > 0
    ? `\nRecent errors (avoid repeating):\n${state.errors.slice(-3).map(e => `- ${e.message}`).join('\n')}`
    : '';

  const userResponseContext = state.current_context.user_response
    ? `\nUSER RESPONSE: "${state.current_context.user_response}"`
    : '';

  const pendingContext = state.current_context.pending_confirmation
    ? `\nPENDING CONFIRMATION: Tool "${state.current_context.pending_confirmation.tool}" needs confirmed:true in args. User said: "${state.current_context.user_response || 'waiting'}"`
    : '';

  const _now = new Date();
  const _tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'local time';
  const _offMin = -_now.getTimezoneOffset();
  const _sign = _offMin >= 0 ? '+' : '-';
  const _abs = Math.abs(_offMin);
  const _offStr = `${_sign}${String(Math.floor(_abs / 60)).padStart(2, '0')}:${String(_abs % 60).padStart(2, '0')}`;
  const nowStr = _now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const recentContext = (Array.isArray(state.recentHistory) && state.recentHistory.length)
    ? `\nRECENT CONVERSATION (REFERENCE ONLY — use it to resolve what "yes"/"it"/"that file"/"the one you just made"/"the load" refer to; your ACTUAL task is the GOAL above, do exactly that and nothing else from here):\n${state.recentHistory.slice(-6).map(h => `${((h.direction || h.role) === 'assistant') ? 'AVA' : 'User'}: ${String(h.content || '').slice(0, 200)}`).join('\n')}\n`
    : '';
  const artifactContext = (Array.isArray(state.recentArtifacts) && state.recentArtifacts.length)
    ? `\nRECENT FILES/ITEMS you just created or used — when the user refers to "it", "that file", "the screenshot/picture you just took", "the one you made", use the EXACT value below (do NOT ask the user for a name/path that's listed here):\n${state.recentArtifacts.map(a => `- ${a.kind}: ${a.value}`).join('\n')}\n`
    : '';
  const envContext = state.environment ? `\n${state.environment}\n` : '';
  const _mem = curatedMemory.buildMemoryBlock();
  let _skills = '';
  try { _skills = skillStore.buildSkillsIndex(); } catch { /* optional */ }
  let _guide = '';
  try { _guide = trainingGuidance.buildGuidanceBlock(); } catch { /* optional */ }
  const head = `${persona.buildPersonaPreamble()}${_mem ? '\n\n' + _mem : ''}${_skills ? '\n\n' + _skills : ''}${_guide ? '\n\n' + _guide : ''}

You are AVA, executing a task step by step. The personality above shapes only the words you SPEAK to the user — it never changes which tool you pick, and never lets you fake or over-claim a result.

GOAL: ${state.goal}
${recentContext}${artifactContext}${envContext}

CURRENT DATE & TIME: ${nowStr} (timezone ${_tz}, UTC${_offStr}). Use this to resolve "today", "tonight", "tomorrow", "this week", "next Monday", etc. — never assume a date from training data. When specifying event start/end times, use full ISO 8601 WITH this offset, e.g. ${_now.getFullYear()}-06-24T15:00:00${_offStr}.

CURRENT STATE:
- Step: ${state.step_count + 1} of ${state.step_limit}
- Status: ${state.status}
${state.last_result ? `- Last result: ${JSON.stringify(state.last_result).slice(0, 200)}` : ''}
${historyContext}
${errorContext}
${userResponseContext}
${pendingContext}
${memoryContext ? '\n' + memoryContext : ''}`;

  // NATIVE FUNCTION-CALLING prompt (Tier 1 #4): tools + their full schemas are passed to the
  // provider natively, so the prompt carries only the behavioral rules — no tool list, no
  // "respond with one JSON object" contract, no JSON-repair needed.
  if (native) {
    return `${head}

HOW TO ACT — you act by CALLING TOOLS (native function calls):
- Call ONE tool at a time. EXCEPTION: you may call SEVERAL tools in a single turn ONLY when they are independent, read-only lookups (nothing that writes/sends/opens/deletes) — they will run in parallel.
- When the request is unclear, garbled, or you need information only the user has, call the ask_user tool with ONE specific question. A wrong or random action (especially opening Explorer/Downloads) is far worse than asking. NEVER open a folder/file/app the user did not explicitly name in THIS goal.
${state.canDelegate ? `- For long / multi-part / multi-step workflows (e.g. research-then-build, several independent parts), call the delegate tool to split the goal into INDEPENDENT subtasks run by parallel subagents, then you synthesize their results. Available subagent roles (each gets only its own scoped tools):
${subagentRoles.rolesForPrompt()}
Pick the role that best fits each subtask ("general" if it spans many categories); to invent a NEW role, include a "define" object (description, prompt, tools) — it is saved for reuse.
` : ''}- When the GOAL is COMPLETE — or it is a question you can answer from the CURRENT STATE, the last result, and context — reply with PLAIN TEXT and NO tool call: that text is your final answer to the user and ends the task. Never describe a tool call in prose; actually call the tool.

CRITICAL RULES:
1. If a tool failed, try an alternative approach — do not repeat the same tool call with the same args. Once a tool has returned the information you need, answer with plain text.
2. After ${state.step_limit} steps you must stop.
3. Tools marked [REQUIRES confirmed:true] MUST have {"confirmed": true} in args. If the last result was "needs_confirm" and the user confirmed, retry with confirmed:true.
4. The open_item tool uses "target" (not "path") for its argument. When a tool's schema has an "action"/"operation" enum, put the chosen action INSIDE args — never append it to the tool name.
5. **USE MEMORY** for preferences, constraints, and facts only. Memory is NOT proof that the current request is already done — you must actually call the tool to fulfill THIS request before claiming it is done.
6. **NEVER claim success for an action you did not actually perform this turn.** To create/update/delete/send anything, you MUST call the relevant tool and see a successful result in THIS run before answering that you did it.
7. **SCOPE — do ONLY what the GOAL explicitly asks; then stop.** Do NOT add unrequested follow-up actions. If asked to "take a screenshot", do NOT also open it. As soon as the explicit request is satisfied by ONE successful tool result, give your final answer.
8. **RECALL — if the GOAL asks what was previously discussed/decided/said, call memory_search with the key topic as the query (do NOT ask the user to narrow it down first). Only after a search returns nothing relevant should you ask for more detail.**
9. **QUESTIONS / DIAGNOSE / STATUS — if the GOAL is a question, asks you to explain/diagnose/report, or is a vague follow-up about a previous step, answer from the CURRENT STATE and last result with plain text — or, for a genuine diagnosis, call the RELEVANT diagnostic tool (e.g. self_awareness). Do NOT substitute an unrelated action.**
10. **FORMS & APPLICATIONS (web).** To fill out ANY web form/application/portal: (a) call profile_ops get_all FIRST to autofill the user's saved info; (b) browser_automation navigate to the page, then get_fields to see the REAL fields and buttons; (c) for any required field you do NOT already have, FIND it via comm_ops search (Gmail) and fs_find / fs_read BEFORE asking the user, and save new facts with profile_ops set; (d) fill with browser_automation fill_form, upload_file for attachments, then click_text to submit. For multi-step forms, fill the page, click Next, get_fields again, continue. If the page shows a CAPTCHA / login challenge you cannot complete legitimately, do NOT bypass it — stop and tell the user you need them to finish that step. You DO have the ability to fill and submit web forms — never say you "can't apply". If asked to "apply for jobs" without a specific link, ask_user for the URL or site (ONE question).

What is your next action?`;
  }

  return `${head}

AVAILABLE TOOLS:
${toolDescriptions}

RESPOND WITH EXACTLY ONE JSON OBJECT (no markdown, no explanation):

For tool execution:
{"decision": "tool_call", "tool": "tool_name", "args": {...}, "reasoning": "why this action"}

For SEVERAL INDEPENDENT read-only lookups at once (none depending on another's result, e.g. search memory AND read a file AND check system state), run them concurrently:
{"decision": "parallel", "tool_calls": [{"tool": "tool_a", "args": {...}}, {"tool": "tool_b", "args": {...}}], "reasoning": "why"}
Use "parallel" ONLY for read-only tools that change nothing and don't depend on each other. Anything that writes/sends/opens/deletes or needs confirmation must be a single "tool_call".
${state.canDelegate ? `
You are the LEAD agent. RECOGNIZE long / multi-step / multi-part / multi-turn workflows EARLY (e.g. "find the photo, turn it into a 3D model, then build the scene"; research-then-build; anything spanning several steps or tool calls) — for those, DELEGATE: break the goal into INDEPENDENT parts and spin up a subagent per part (each a full agent with a SCOPED role toolset, running in parallel), then synthesize their results:
{"decision": "delegate", "subtasks": [{"role": "<existing or NEW role>", "goal": "<one focused instruction>", "define": {"description":"...","prompt":"specialized instructions","tools":["tool_a","tool_b"]}}, ...], "reasoning": "why split it this way"}
Available subagent roles (each gets only its own scoped tools):
${subagentRoles.rolesForPrompt()}
Pick the role that best fits each subtask (use "general" if it spans many categories). If NONE of them fit, INVENT a new role: give it a fresh name plus a "define" object (description, specialized prompt, and the focused tools it needs) — include "define" ONLY when creating a new role; it is SAVED for reuse later. Prefer delegating for any sizable, long, or multi-step goal; only skip it for a single quick step. After the subagents return, you'll synthesize a final answer.
` : ''}
For clarification needed:
{"decision": "ask_user", "question": "what you need to know", "reasoning": "why you need this"}

For task complete:
{"decision": "stop", "result": "summary of what was accomplished", "success": true/false}

CRITICAL RULES:
1. Execute ONE tool at a time — EXCEPT you may use the "parallel" form to run several INDEPENDENT read-only lookups concurrently
2. If a tool failed, try an alternative approach  
3. If you lack information, ask the user
4. After ${state.step_limit} steps, you must stop
5. **IMPORTANT**: Tools marked [REQUIRES confirmed:true] MUST have {"confirmed": true} in args
6. If last result was "needs_confirm" and user confirmed, retry with confirmed:true in args
7. The open_item tool uses "target" not "path" for its argument
8. ACTION FORMAT: when a tool shows "set args.action to one of: ...", keep the tool name EXACTLY as given and put the chosen action INSIDE args, e.g. {"tool":"comm_ops","args":{"action":"read_emails"}}. NEVER append the action to the tool name (not "comm_ops.read_emails") and NEVER pass it as a boolean key (not {"get_today":true}).
9. Do NOT repeat the same tool call with the same args. Once a tool has returned the information you need, choose "stop" and give the answer.
10. **USE MEMORY** for preferences, constraints, and facts only. Memory is NOT proof that the current request is already done — even if you "previously" did something similar, you must actually call the tool to fulfill THIS request before you "stop".
11. **NEVER claim success for an action you did not actually perform this turn.** To create/update/delete/send anything, you MUST call the relevant tool and see a successful result in THIS run before stopping with success:true. If you only looked something up or nothing executed, do not say you did it.
12. **SCOPE — do ONLY what the GOAL explicitly asks; then STOP.** Do NOT add unrequested follow-up actions. If asked to "take a screenshot", do NOT also open it. If asked to "create/save a file", do NOT also open or read it. If asked to "send an email", do NOT also read the inbox. As soon as the user's explicit request is satisfied by ONE successful tool result, choose "stop" — do not keep acting "to be helpful".
13. **RECALL — if the GOAL asks what was previously discussed/decided/said (e.g. "what did we discuss about X"), call memory_search with the key topic as the query (do NOT ask the user to narrow it down first). Only after a search returns nothing relevant should you ask for more detail.**
14. **QUESTIONS / DIAGNOSE / STATUS — if the GOAL is a question, asks you to explain/diagnose/report, or is a vague follow-up about a previous step (e.g. "what is the result", "what happened", "tell me what to do", "why did that fail", "diagnose the issue"), answer from the CURRENT STATE, the Last result, and context with "stop" — or, for a genuine diagnosis, call the RELEVANT diagnostic tool (e.g. self_awareness). Do NOT substitute an unrelated action.**
15. **NEVER open a folder, file, app, or browser the user did NOT explicitly name in THIS goal. Opening Downloads/Documents/Explorer is valid ONLY when the user clearly asked to open that exact place. Do not use opening a folder/file as a stand-in for something else.**
16. **NO GUESSING / ASK WHEN UNSURE — if the request is unclear, garbled, ambiguous, or you can't tell what action the user wants, do NOT run any tool and do NOT open File Explorer, a folder, or an app as a fallback. Choose "ask_user" and ask a specific clarifying question. A wrong or random action (especially opening Explorer/Downloads) is far worse than asking. Opening Explorer/Downloads/an app is ONLY valid when the user explicitly asked to open that exact thing.**
17. **FORMS & APPLICATIONS (web).** To fill out ANY web form/application/portal: (a) call profile_ops get_all FIRST to autofill the user's saved info (name, email, phone, address, etc.); (b) browser_automation navigate to the page, then get_fields to see the REAL fields and buttons; (c) for any required field you do NOT already have, FIND it by searching the user's own sources — comm_ops search (Gmail) and fs_find / fs_read (files/documents on this PC) — BEFORE asking them, and save new facts with profile_ops set so you have them next time; (d) fill with browser_automation fill_form (text + <select>) and upload_file for attachments (if the file is in email, download it first with comm_ops download_attachment, then pass its path), then click_text to submit. For CUSTOM dropdowns / date pickers, use click_text to open the control then click the option. For MULTI-STEP forms, fill the page, click_text the Next button, then get_fields again and continue. If the page shows a CAPTCHA / "verify you are human" / login challenge you cannot complete legitimately, do NOT try to bypass it — stop and tell the user you need them to finish that one step. You DO have the ability to fill out and submit web forms/applications — NEVER tell the user you "can't apply" or that they must do it themselves. If they say "apply for jobs" / "fill out the applications" but you don't have a specific job link or site, ASK them for the URL or which site (ONE question) — do NOT stall, deny, or open File Explorer.

What is your next action?`;
}

/**
 * Build the native function-calling toolset (Tier 1 #4): the real tools with their FULL schemas
 * (so the model sees exact arg names + action enums instead of a prose hint), plus two control
 * tools — ask_user, and delegate for the lead agent. "Stop" is simply a plain-text reply.
 */
function buildNativeTools(state) {
  const tools = (state.toolset || []).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: `${t.description || ''}${t.requires_confirm ? ' [REQUIRES confirmed:true in args]' : ''}${t.risk_level === 'high' ? ' [HIGH RISK]' : ''}`,
      parameters: (t.schema && t.schema.type) ? t.schema : { type: 'object', properties: {} }
    }
  }));
  tools.push({
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Ask the user ONE specific clarifying question and wait for their answer. Use when the request is unclear/ambiguous or you need information only the user has. Ends your turn.',
      parameters: { type: 'object', properties: { question: { type: 'string', description: 'The single specific question to ask' } }, required: ['question'] }
    }
  });
  if (state.canDelegate) {
    tools.push({
      type: 'function',
      function: {
        name: 'delegate',
        description: 'LEAD ONLY: split a long multi-part goal into INDEPENDENT subtasks, each run by a parallel subagent with a scoped role toolset; you synthesize the results afterwards. Prefer this for sizable multi-step workflows.',
        parameters: {
          type: 'object',
          properties: {
            subtasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', description: 'Existing role name, or a NEW role name (then include define)' },
                  goal: { type: 'string', description: 'One focused instruction for this subagent' },
                  define: {
                    type: 'object',
                    description: 'Only when inventing a NEW role',
                    properties: {
                      description: { type: 'string' },
                      prompt: { type: 'string', description: 'Specialized instructions for the role' },
                      tools: { type: 'array', items: { type: 'string' } }
                    }
                  }
                },
                required: ['goal']
              }
            },
            reasoning: { type: 'string' }
          },
          required: ['subtasks']
        }
      }
    });
  }
  return tools;
}

/**
 * Map a native tool-calling response onto the loop's decision shape.
 * Returns null when the response is unusable (caller falls back to the legacy JSON path).
 */
function mapNativeDecision(state, resp) {
  const calls = (resp && resp.toolCalls) || [];
  const text = String((resp && resp.text) || '').trim();

  if (calls.length) {
    const askUser = calls.find(c => c.name === 'ask_user');
    if (askUser) {
      return { decision: DecisionType.ASK_USER, question: String(askUser.args.question || 'Could you clarify what you need?'), reasoning: 'model requested clarification' };
    }
    const delegate = calls.find(c => c.name === 'delegate');
    if (delegate && state.canDelegate && Array.isArray(delegate.args.subtasks) && delegate.args.subtasks.length) {
      return { decision: DecisionType.DELEGATE, subtasks: delegate.args.subtasks, reasoning: String(delegate.args.reasoning || '') };
    }
    const real = calls.filter(c => c.name !== 'ask_user' && c.name !== 'delegate');
    if (real.length > 1) {
      return { decision: DecisionType.PARALLEL, tool_calls: real.map(c => ({ tool: c.name, args: c.args || {} })), reasoning: 'parallel read-only fan-out' };
    }
    if (real.length === 1) {
      return { decision: DecisionType.TOOL_CALL, tool: real[0].name, args: real[0].args || {}, reasoning: '' };
    }
  }

  // Plain text with no tool calls = the final answer (STOP).
  if (text) return { decision: DecisionType.STOP, result: text, success: true };
  return null;
}

/**
 * DECIDE: Call LLM to determine next action
 */
async function decide(state, observations) {
  logger.info('[agent] Decide', { step: state.step_count });

  // Check if we have a pending confirmation and user confirmed
  if (state.current_context.pending_confirmation && state.current_context.user_response) {
    const userResponse = state.current_context.user_response.toLowerCase();
    const isConfirmed = userResponse.includes('yes') || 
                        userResponse.includes('confirm') || 
                        userResponse.includes('ok') ||
                        userResponse.includes('proceed') ||
                        userResponse.includes('go ahead');
    
    if (isConfirmed) {
      const pending = state.current_context.pending_confirmation;
      logger.info('[agent] Auto-confirming pending tool', { tool: pending.tool });
      
      state.current_context.pending_confirmation = null;
      state.current_context.user_response = null;
      
      return {
        decision: DecisionType.TOOL_CALL,
        tool: pending.tool,
        args: { ...pending.args, confirmed: true },
        reasoning: 'User confirmed the action'
      };
    }
  }

  // PRIMARY PATH (Tier 1 #4): native function calling — tools with full schemas go to the
  // provider natively; no JSON contract, no repair pipeline. Disable with AVA_NATIVE_TOOLS=0.
  if (process.env.AVA_NATIVE_TOOLS !== '0') {
    try {
      const nativeResp = await llmService.chatWithTools([
        { role: 'system', content: 'You are AVA, a task execution agent. Act by calling tools; reply with plain text only when the task is complete or you can answer directly.' },
        { role: 'user', content: buildDecisionPrompt(state, observations, true) }
      ], {
        tools: buildNativeTools(state),
        temperature: 0.3,
        max_tokens: parseInt(process.env.AVA_DECISION_MAX_TOKENS || '', 10) || 4000,
        model: modelConfig.decisionModel()
      });
      const nativeDecision = mapNativeDecision(state, nativeResp);
      if (nativeDecision) {
        logger.info('[agent] Decision made (native)', {
          type: nativeDecision.decision,
          tool: nativeDecision.tool,
          provider: nativeResp.provider
        });
        return nativeDecision;
      }
      logger.warn('[agent] Native decision empty (no text, no tool calls); falling back to JSON path', { provider: nativeResp.provider });
    } catch (e) {
      logger.warn('[agent] Native tool-calling decide failed; falling back to JSON path', { error: e.message });
    }
  }

  const prompt = buildDecisionPrompt(state, observations);

  try {
    const response = await llmService.chat([
      { role: 'system', content: 'You are a task execution agent. Respond only with valid JSON.' },
      { role: 'user', content: prompt }
    ], {
      temperature: 0.3,
      max_tokens: parseInt(process.env.AVA_DECISION_MAX_TOKENS || '', 10) || 4000,  // headroom so the decision JSON doesn't truncate mid-string
      model: modelConfig.decisionModel()
    });

    const text = response.text || response.content || '';
    
    const decision = parseDecisionJson(text);

    // Parallel fan-out: if the model returned a `tool_calls` array, route it to the PARALLEL path
    // (multiple) or collapse a single entry into a normal tool_call.
    if (Array.isArray(decision.tool_calls) && decision.tool_calls.filter(c => c && c.tool).length > 1) {
      decision.decision = DecisionType.PARALLEL;
    } else if (Array.isArray(decision.tool_calls) && decision.tool_calls.length === 1 && decision.tool_calls[0] && decision.tool_calls[0].tool && !decision.tool) {
      decision.tool = decision.tool_calls[0].tool;
      decision.args = decision.tool_calls[0].args || {};
      decision.decision = DecisionType.TOOL_CALL;
    }

    // Delegation: route a `subtasks`/`subagents` array (or decision 'delegate') to the DELEGATE path.
    // ONLY the lead may delegate — subagents run with canDelegate=false (their delegate is blocked in act).
    if (state.canDelegate && (decision.decision === 'delegate' || Array.isArray(decision.subtasks) || Array.isArray(decision.subagents))) {
      decision.subtasks = decision.subtasks || decision.subagents || [];
      if (Array.isArray(decision.subtasks) && decision.subtasks.length) decision.decision = DecisionType.DELEGATE;
    }

    // Tolerant recovery: the model sometimes puts the TOOL NAME in `decision`
    // (e.g. decision:"memory_search") instead of decision:"tool_call", tool:"memory_search".
    // Coerce that into a proper tool_call rather than hard-failing the whole step.
    if (!decision.decision || !Object.values(DecisionType).includes(decision.decision)) {
      if (decision.decision && !decision.tool && /^[a-z_][a-z0-9_]*$/i.test(decision.decision)) {
        decision.tool = decision.decision;
        decision.decision = DecisionType.TOOL_CALL;
        logger.warn('[agent] Coerced tool-name decision into tool_call', { tool: decision.tool });
      } else if (decision.tool) {
        decision.decision = DecisionType.TOOL_CALL;
        logger.warn('[agent] Invalid decision type but tool present; assuming tool_call', { tool: decision.tool });
      } else {
        // No recognizable decision type and no tool. The model occasionally returns prose or an
        // empty envelope for a perfectly clear request (e.g. "do a self-diagnostic"). Retry ONCE
        // with a stricter, example-led nudge before giving up — a general robustness win.
        let retried = null;
        try {
          const r2 = await llmService.chat([
            { role: 'system', content: 'You are a task execution agent. Respond with EXACTLY ONE JSON object and no prose. To use a tool: {"decision":"tool_call","tool":"<tool_name>","args":{...}}. To answer directly: {"decision":"stop","result":"<your answer>","success":true}.' },
            { role: 'user', content: prompt }
          ], {
            temperature: 0.2,
            max_tokens: parseInt(process.env.AVA_DECISION_MAX_TOKENS || '', 10) || 4000,
            model: modelConfig.decisionModel()
          });
          retried = parseDecisionJson(r2.text || r2.content || '');
        } catch { retried = null; }

        if (retried && retried.decision && Object.values(DecisionType).includes(retried.decision)) {
          Object.assign(decision, retried);
          logger.warn('[agent] Decision retry succeeded', { type: decision.decision, tool: decision.tool });
        } else if (retried && retried.tool) {
          decision.tool = retried.tool;
          decision.args = retried.args || decision.args;
          decision.decision = DecisionType.TOOL_CALL;
          logger.warn('[agent] Decision retry produced a tool', { tool: decision.tool });
        } else {
          // Still nothing usable — answer directly rather than HARD-FAIL the turn (which used to
          // surface as "I encountered an error deciding the next step: Invalid decision type").
          const fallbackText = String(
            decision.result || decision.answer || decision.message || decision.response
            || decision.reasoning || decision.question
            || (typeof text === 'string' && !text.trim().startsWith('{') ? text.trim() : '')
            || ''
          ).trim();
          decision.decision = DecisionType.STOP;
          decision.result = fallbackText || "Let me answer that directly — could you say a little more about what you'd like me to check?";
          decision.success = !!fallbackText;
          logger.warn('[agent] Invalid/empty decision after retry; answering directly', { hadText: !!fallbackText });
        }
      }
    }

    logger.info('[agent] Decision made', { 
      type: decision.decision, 
      tool: decision.tool,
      reasoning: decision.reasoning?.slice(0, 100)
    });

    return decision;

  } catch (e) {
    logger.error('[agent] Decision failed', { error: e.message });
    
    return {
      decision: DecisionType.ASK_USER,
      question: `I encountered an error deciding the next step: ${e.message}. How should I proceed?`,
      reasoning: 'Decision parsing failed'
    };
  }
}

/**
 * ACT: Execute the decided action
 */
async function act(state, decision) {
  logger.info('[agent] Act', { step: state.step_count, type: decision.decision });

  const action = {
    type: decision.decision,
    timestamp: new Date().toISOString(),
    step: state.step_count
  };

  let result = { status: 'unknown' };

  try {
    switch (decision.decision) {
      case DecisionType.TOOL_CALL:
        action.tool = decision.tool;
        action.args = decision.args || {};

        // ROLE SCOPING: hard-block any tool outside a role-scoped subagent's toolset.
        if (!_toolAllowed(state, decision.tool)) {
          result = { status: 'error', message: `Tool '${decision.tool}' is not in this subagent's role toolset${state.role ? ` (${state.role})` : ''}.` };
          break;
        }

        // Honor runTools=false: skip tool execution, return conversational-only
        if (!state.runTools) {
          logger.info('[agent] runTools=false, skipping tool execution', { tool: decision.tool });
          result = { status: 'skipped', message: 'Tool execution disabled for this request (run_tools=false)' };
          break;
        }

        const tool = await toolsService.getTool(decision.tool);
        if (!tool) {
          result = { status: 'error', message: `Tool not found: ${decision.tool}` };
          break;
        }

        // Tier 3 #22 READ-ONLY gate: for self-initiated proactive investigation, refuse any
        // side-effectful action STRUCTURALLY (not via prompt). A tool is blocked when it's
        // confirm-gated, high/medium risk, matches the destructive-family prefixes, or the model
        // tried to sneak a confirm/confirmed flag. The stage still gets a clear result so it can
        // record the finding as "would require your approval" instead of doing it.
        if (state.readOnly) {
          const RO_DESTRUCTIVE = /^(fs_(write|append|delete|move|copy|mkdir|rmdir)|ps_exec|file_gen|app_control|comm_|voice_|camera_|calendar_ops|iot_ops|remote_ops|web_automation|open_item|self_mod)/;
          const risky = tool.requires_confirm || (tool.risk_level && tool.risk_level !== 'low')
            || RO_DESTRUCTIVE.test(decision.tool) || action.args.confirm || action.args.confirmed;
          if (risky) {
            result = {
              status: 'blocked_readonly',
              message: `Read-only investigation: ${decision.tool} would take a real action, which needs your approval. Noting it as a recommendation instead of doing it.`,
              tool: decision.tool,
            };
            logger.info('[agent] read-only gate blocked a side-effect', { tool: decision.tool });
            break;
          }
        }

        // Autonomy policy gate
        try {
          const { getAutonomy } = autonomyLib;
          const autonomy = getAutonomy(logger);
          const category = (decision.tool === 'ps_exec')
            ? 'system_commands'
            : ((decision.tool || '').startsWith('fs_') || decision.tool === 'file_gen')
              ? 'file_write_outside_allowlist'
              : undefined;
          const requiresWrite = !!(category || tool.requires_confirm || action.args.confirm || action.args.confirmed);
          const policyDecision = autonomy.decide({
            domain: 'personal_assistant',
            trigger: null,
            signal: { impact: 2, timeSensitivity: 1, confidence: 1, disruptionCost: 0.3 },
            risk: { toolRisk: tool.risk_level, category },
            requiresWrite,
            isUserInitiated: true
          });
          if (policyDecision.outcome === 'do_nothing' || policyDecision.outcome === 'log_only') {
            result = { status: 'skipped', message: 'Autonomy policy blocked action' };
            break;
          }
          if (policyDecision.outcome === 'notify') {
            try { autonomy.recordOutcome('notify'); } catch {}
          }
          if (policyDecision.outcome === 'ask_permission' && !action.args.confirm && !action.args.confirmed) {
            state.current_context.pending_confirmation = { tool: decision.tool, args: action.args };
            result = { status: 'needs_permission', message: `Autonomy policy requires permission for ${decision.tool}` };
            break;
          }
          // else proceed
        } catch (e) { /* autonomy gate best-effort */ }

        if (tool.requires_confirm && !action.args.confirmed && !action.args.confirm) {
          state.current_context.pending_confirmation = {
            tool: decision.tool,
            args: action.args
          };
          result = { 
            status: 'needs_confirm', 
            message: `Tool ${decision.tool} requires confirmation. Add confirmed:true to args.`,
            tool: decision.tool,
            args: action.args
          };
          break;
        }

        if (action.args.confirmed && !action.args.confirm) {
          action.args.confirm = true;
        }

        // Anti-spin: if this exact tool + executed args already ran this loop, reuse
        // the prior result and stop, instead of running it again (prevents spins like
        // open_item being executed 7+ times).
        const _execSig = JSON.stringify(action.args || {});
        const _priorRun = (state.history || []).find(h => {
          const ht = h && ((h.decision && h.decision.tool) || (h.action && h.action.tool));
          const ha = h && h.action && h.action.args;
          return ht === decision.tool && JSON.stringify(ha || {}) === _execSig && h.result;
        });
        if (_priorRun) {
          result = _priorRun.result || { status: 'ok', message: 'Already done a moment ago.' };
          const _spinOk = String(result.status || '').toLowerCase() === 'ok';
          state.status = _spinOk ? AgentStatus.SUCCESS : AgentStatus.FAILED;
          // Surface the REAL failure reason (tools return .error, not .message, on failure) so a
          // dead-end says WHY instead of a bare "I could not complete that." (log-review fix).
          state.final_result = state.final_result || result.message || result.error || (_spinOk ? 'Done.' : "I couldn't complete that — my last tool didn't return a result.");
          logger.info('[agent] Anti-spin: repeated tool+args, reusing prior result', { tool: decision.tool });
          break;
        }

        // GUARD: never open File Explorer / a folder / an app the user did NOT actually
        // mention. When a request is unclear the model used to default to opening
        // Explorer/Downloads — block that and ask for clarity instead.
        if (decision.tool === 'open_item') {
          const _tgt = String((action.args && (action.args.target || action.args.path)) || '').toLowerCase();
          const _goal = String(state.goal || '').toLowerCase();
          const _generic = /\b(explorer|file explorer|downloads?|documents?|desktop|pictures?|music|videos?|this pc|my computer|home|folder|files?)\b/;
          if (_generic.test(_tgt) && !_generic.test(_goal)) {
            state.status = AgentStatus.SUCCESS;
            state.final_result = "I'm not sure what you'd like me to do — could you say it a different way, or tell me the specific task? For example: \"fill out this application: <link>\", \"search my email for <thing>\", or \"open my downloads folder\".";
            logger.info('[agent] Blocked generic open_item not in goal; asking for clarity', { target: _tgt });
            break;
          }
        }

        logger.info('[agent] Executing tool', { tool: decision.tool, args: action.args });
        const toolResult = await toolsService.executeTool(decision.tool, action.args, false, { source: state.eventSource || '' });
        result = toolResult.result || toolResult;
        try {
          const { getAutonomy } = autonomyLib; const autonomy = getAutonomy(logger);
          autonomy.recordOutcome('act_then_report');
        } catch {}
        
        if (result.status === 'ok') {
          state.current_context.pending_confirmation = null;
        }
        break;

      case DecisionType.PARALLEL: {
        if (!state.runTools) { result = { status: 'skipped', message: 'Tool execution disabled (run_tools=false)' }; break; }
        const calls = (decision.tool_calls || []).filter(c => c && c.tool).slice(0, 6);
        action.tool_calls = calls;
        // Only NON-destructive, no-confirm tools run concurrently. Anything that writes or needs
        // confirmation is returned as 'deferred' so the model re-issues it as a normal single
        // tool_call (which passes through the full autonomy + confirmation gates). This gives the
        // read fan-out speed-up WITHOUT ever running an unconfirmed side effect in parallel.
        const DESTRUCTIVE = /^(fs_|ps_exec|file_gen|app_control|web_|comm_|voice_|camera_)/;
        const parResults = await Promise.all(calls.map(async (c) => {
          try {
            const t = await toolsService.getTool(c.tool);
            if (!t) return { tool: c.tool, result: { status: 'error', message: `Tool not found: ${c.tool}` } };
            if (!_toolAllowed(state, c.tool)) return { tool: c.tool, result: { status: 'blocked', message: `${c.tool} not in this role's toolset` } };
            const unsafe = t.requires_confirm || DESTRUCTIVE.test(c.tool) || (t.risk_level && t.risk_level !== 'low');
            if (unsafe) return { tool: c.tool, result: { status: 'deferred', message: `${c.tool} needs sequential/confirmed execution — issue it as a single tool_call` } };
            const r = await toolsService.executeTool(c.tool, c.args || {}, false, { source: state.eventSource || '' });
            return { tool: c.tool, result: r.result || r };
          } catch (e) { return { tool: c.tool, result: { status: 'error', message: e.message } }; }
        }));
        const okN = parResults.filter(r => String(r.result.status).toLowerCase() === 'ok').length;
        result = { status: okN ? 'ok' : 'error', parallel: true, results: parResults, message: parResults.map(r => `${r.tool}: ${r.result.status}`).join('; ') };
        logger.info('[agent] Parallel tools executed', { count: calls.length, ok: okN });
        break;
      }

      case DecisionType.DELEGATE: {
        if (!state.canDelegate) { result = { status: 'error', message: 'Subagents cannot delegate further.' }; break; }
        if (!state.runTools) { result = { status: 'skipped', message: 'Delegation disabled (run_tools=false)' }; break; }
        const subtasks = (decision.subtasks || []).filter(s => s && (s.goal || typeof s === 'string'));
        if (!subtasks.length) { result = { status: 'error', message: 'No subtasks provided to delegate.' }; break; }
        action.subtasks = subtasks;
        try {
          // Lazy import avoids the subagentOrchestrator <-> agentLoop circular dependency at load time.
          const orch = (await import('./subagentOrchestrator.js')).default;
          const out = await orch.orchestrate({ goal: state.goal, subtasks, sharedContext: state.goal, synthesize: false });
          const subs = (out && out.subagents) || [];
          const okN = subs.filter(s => s.status === 'done').length;
          result = {
            status: okN ? 'ok' : 'error',
            delegated: true,
            message: `Spawned ${subs.length} subagent(s): ` + subs.map(s => `${s.role}=${s.status}`).join(', '),
            subagents: subs.map(s => ({ role: s.role, status: s.status, result: s.result })),
          };
          logger.info('[agent] Delegated to subagents', { count: subs.length, ok: okN });
        } catch (e) {
          result = { status: 'error', message: `Delegation failed: ${e.message}` };
        }
        break;
      }

      case DecisionType.ASK_USER:
        action.question = decision.question;
        result = { status: 'waiting', question: decision.question };
        state.status = AgentStatus.WAITING_USER;
        break;

      case DecisionType.STOP:
        action.result = decision.result;
        action.success = decision.success;
        result = { status: 'complete', result: decision.result, success: decision.success };
        state.status = decision.success ? AgentStatus.SUCCESS : AgentStatus.FAILED;
        state.final_result = decision.result;
        break;

      default:
        result = { status: 'error', message: `Unknown decision type: ${decision.decision}` };
    }

  } catch (e) {
    logger.error('[agent] Action failed', { error: e.message, tool: decision.tool });
    result = { status: 'error', message: e.message };
  }

  if (result.status === 'error') {
    state.errors.push({
      step: state.step_count,
      action: decision.tool || decision.decision,
      message: result.message,
      timestamp: new Date().toISOString()
    });
    state.consecutive_errors++;
    // Error -> lesson: distill a preventive lesson into memory in the background
    // (non-blocking) so the same failure doesn't recur.
    try {
      if (decision.tool && process.env.AVA_SANDBOX !== '1') {
        setTimeout(() => {
          lessonLearner.lessonFromError({
            tool: decision.tool, args: decision.args, error: result.message, goal: state.goal,
          }).catch(() => {});
        }, 50);
      }
    } catch { /* never block */ }
  } else if (result.status !== 'needs_confirm') {
    state.consecutive_errors = 0;
  }

  state.last_action = action;
  state.last_result = result;

  return { action, result };
}

/**
 * RECORD: Save step to history and memory
 * Phase 5: Enhanced memory storage with types
 */
async function record(state, observations, decision, actionResult) {
  logger.info('[agent] Record', { step: state.step_count });

  const historyEntry = {
    step: state.step_count,
    timestamp: new Date().toISOString(),
    observations: {
      tools_available: observations.tools_available,
      memories_found: observations.memories_found,
      memories_used: observations.memory_prompt ? true : false,
      last_action: observations.last_action,
      user_response: observations.user_response
    },
    decision: {
      type: decision.decision,
      tool: decision.tool,
      reasoning: decision.reasoning
    },
    action: actionResult.action,
    result: actionResult.result
  };

  state.history.push(historyEntry);
  state.updated_at = new Date().toISOString();

  // Phase 5: Store significant events with proper types
  try {
    const res = actionResult.result || {};
    const status = String(res.status || '').toLowerCase();
    const message = String(res.message || '');
    const toolName = decision.tool || historyEntry.action?.tool || '';

    if (actionResult.result?.status === 'ok' && decision.tool) {
      await memoryService.store({
        text: `Successfully used ${decision.tool} for: ${state.goal.slice(0, 100)}. Args: ${JSON.stringify(decision.args || {}).slice(0, 200)}`,
        type: MemoryType.AGENT_ACTION,
        priority: 3,
        source: MemorySource.SYSTEM,
        tags: ['agent', 'tool', decision.tool]
      });
    }
    
    if (actionResult.result?.status === 'complete' && actionResult.result?.success) {
      await memoryService.store({
        text: `Completed task: ${state.goal}. Result: ${actionResult.result.result || 'success'}`,
        type: MemoryType.WORKFLOW,
        priority: 4,
        source: MemorySource.LEARNED,
        tags: ['workflow', 'success', 'completed']
      });
    }
    
    if (state.errors.length > 0 && actionResult.result?.status === 'error') {
      const lastError = state.errors[state.errors.length - 1];
      // NOTE: we deliberately do NOT store an "Avoid this approach" WARNING memory
      // here. Doing so made transient failures (an expired token, a one-off bad arg)
      // permanently poison future decisions, so she'd refuse tools that actually work.
      // Failures are still tracked for diagnostics below, just not fed back as
      // decision-blocking memory.

      // Track issue for Moltbook help
      try {
        const category = (decision.tool || '').includes('voice') ? 'voice'
          : (decision.tool || '').includes('audio') ? 'voice'
          : 'tool';
        moltbookScheduler.trackIssue(category, lastError.message, {
          tool: decision.tool,
          goal: state.goal?.slice(0, 100),
          error: lastError.message,
          attempted: `Used ${decision.tool} with args`
        });
      } catch (e) {
        // Ignore tracking errors
      }

      // Curiosity: explain last tool error under policy governance, enqueue digest (non-interruptive)
      try {
        const rel1 = jaccardSim(message, state.goal || '');
        const rel2 = jaccardSim(message, toolName || '');
        const relevanceScore = Math.max(rel1, rel2);
        const query = `Explain likely causes and fixes for this error in ${toolName}: ${message}`;
        const result = await curiosity.run({
          trigger: 'gap_detected',
          domain: 'web_research',
          scopeMinutes: 5,
          plannedFindings: 1,
          isUserInitiated: false,
          query,
          signal: { relevanceScore, impact: 2, timeSensitivity: 1, confidence: 2, disruptionCost: 0.9 },
          task: async () => {
            // Provide a heuristic explanation finding (no external network)
            const text = `Likely cause: selector drift or missing permission for ${toolName}. Suggested fix: validate selectors, add waits, or fallback to vision-based click. Error: ${message}`;
            return { findings: [{ text, relevanceScore, url: '' }] };
          }
        });
        // Enqueue digest item from finding (no interrupt)
        const top = (result.rawFindings && result.rawFindings[0]) || null;
        if (top) {
          digestQueue.enqueue({
            domain: 'web_research',
            trigger: 'gap_detected',
            title: `Tool error in ${toolName}`,
            summary: top.text.slice(0, 240),
            links: top.url ? [top.url] : [],
            evidence: { tool: toolName, error: message, step: state.step_count, agentId: state.id },
            recommendedAction: result.outcome === 'act_then_report' ? 'ask_permission' : 'notify'
          });
        }
      } catch (e) {
        logger.warn('[curiosity] error supervisor failed', { error: e.message });
      }
    }

    // Automatic learning: capture user corrections without explicit "learn" prompts
    const userResp = observations?.user_response || state.current_context?.user_response || '';
    const looksLikeCorrection = typeof userResp === 'string' && /\b(use|should be|correct|instead|the (address|title|path) is|actually)\b/i.test(userResp);
    if (looksLikeCorrection) {
      await memoryService.store({
        text: `Correction noted for goal: ${state.goal.slice(0, 120)}\nUser said: ${String(userResp).slice(0, 240)}`,
        type: MemoryType.CONSTRAINT,
        priority: 4,
        source: MemorySource.CORRECTION,
        tags: ['correction', toolName].filter(Boolean)
      });
    }

    // Automatic learning: only capture the genuinely useful "this tool needs
    // confirmation" constraint. We intentionally do NOT store error / not-found /
    // auth / missing messages as constraints — that made transient failures
    // permanently block her from retrying tools that actually work.
    const needsConfirmConstraint = /requires confirmation|confirmation required|confirmed:\s*true/i.test(message);
    if (needsConfirmConstraint && toolName) {
      await memoryService.store({
        text: `Constraint detected while using ${toolName}: ${message.slice(0, 240)} (goal: ${state.goal.slice(0, 100)})`,
        type: MemoryType.CONSTRAINT,
        priority: 4,
        source: MemorySource.SYSTEM,
        tags: ['constraint', 'auto_learn', toolName]
      });
    }
  } catch (e) {
    logger.warn('[agent] Failed to store memory', { error: e.message });
  }

  return historyEntry;
}

/**
 * Check if agent should continue
 */
function shouldContinue(state) {
  if (state.status !== AgentStatus.RUNNING) {
    return false;
  }

  // Tier 2 #14: wall-clock deadline (set by long-horizon callers like the workflow engine).
  // Checked between steps, so a stage that overruns its budget stops CLEANLY at the next
  // boundary instead of running forever; the caller's retry/replan machinery takes over.
  if (state.deadline_at && Date.now() > state.deadline_at) {
    state.status = AgentStatus.FAILED;
    state.final_result = `Deadline exceeded after ${state.step_count} steps (budget ${Math.round((state.deadline_at - state.started_at_ms) / 1000)}s). Last action: ${state.last_action?.tool || 'none'}`;
    return false;
  }

  if (state.step_count >= state.step_limit) {
    state.status = AgentStatus.STEP_LIMIT;
    state.final_result = `Step limit (${state.step_limit}) reached. Last action: ${state.last_action?.tool || 'none'}`;
    return false;
  }

  if (state.consecutive_errors >= MAX_CONSECUTIVE_ERRORS) {
    state.status = AgentStatus.FAILED;
    state.final_result = `Too many consecutive errors (${MAX_CONSECUTIVE_ERRORS})`;
    return false;
  }

  return true;
}

/**
 * Run the agent loop
 */
async function runAgentLoop(goal, options = {}) {
  const state = createAgentState(goal, options);

  logger.info('[agent] Starting loop', { id: state.id, goal: goal.slice(0, 100), stepLimit: state.step_limit });

  // Tier 2 #15: tell the UI explicitly when real work starts/ends, so it never has to
  // GUESS with idle timeouts (the client's old 15s "working" hack is gone). NOTE: this
  // main entry has its own inlined loop — runAgentLoopFromState below is only the
  // resume-after-waiting_user path, which carries the same events.
  try { emitVoiceEvent('agent.state', { state: 'working.start', id: state.id, goal: String(goal || '').slice(0, 140) }, 'agent'); } catch { /* ui push is best-effort */ }

  try {
    while (shouldContinue(state)) {
      state.step_count++;

      const observations = await observe(state);
      const decision = await decide(state, observations);

      // Anti-spin guard: if the model picks a tool+args it ALREADY ran this loop, do
      // NOT re-run it — stop and use the prior result. Prevents the loop from calling
      // the same action repeatedly (e.g. open_item 7+ times) and burning all steps.
      if (decision && decision.decision === 'tool_call' && decision.tool) {
        const _sig = JSON.stringify(decision.args || {});
        const _prior = [...(state.history || [])].reverse().find(h => {
          const ht = h && ((h.decision && h.decision.tool) || (h.action && h.action.tool));
          const ha = (h && h.action && h.action.args) || (h && h.decision && h.decision.args) || {};
          return ht === decision.tool && JSON.stringify(ha) === _sig;
        });
        if (_prior && _prior.result) {
          const _ok = String(_prior.result.status || '').toLowerCase() === 'ok';
          state.last_result = _prior.result;
          state.status = _ok ? AgentStatus.SUCCESS : AgentStatus.FAILED;
          state.final_result = state.final_result || (_ok ? (_prior.result.message || 'Done.') : (_prior.result.message || _prior.result.error || "I couldn't complete that — my last tool didn't return a result."));
          logger.info('[agent] Anti-spin: repeated tool+args, stopping with prior result', { tool: decision.tool });
          break;
        }
      }

      const actionResult = await act(state, decision);
      await record(state, observations, decision, actionResult);

      // Tier 2 #14: per-step heartbeat for long-horizon supervisors (progress + stuck detection).
      if (state.onStep) { try { state.onStep(state, decision, actionResult); } catch { /* never break the loop */ } }

      // Scope: a single-action goal stops after the FIRST successful tool result, so the
      // loop doesn't tack on unrequested follow-up actions (e.g. take screenshot THEN open).
      if (!state._multiStep && decision && decision.decision === 'tool_call'
          && actionResult && actionResult.result
          && String(actionResult.result.status).toLowerCase() === 'ok') {
        state.status = AgentStatus.SUCCESS;
        if (!state.final_result) {
          if (INFO_TOOLS.has(decision.tool)) {
            const _syn = await synthesizeAnswer(state.goal, decision.tool, actionResult.result);
            state.final_result = _syn || actionResult.result.message || 'Done.';
          } else {
            state.final_result = actionResult.result.message || 'Done.';
          }
        }
        logger.info('[agent] Scope: single-action complete, stopping', { goal: String(state.goal).slice(0, 40) });
        break;
      }

      if (state.status === AgentStatus.WAITING_USER) {
        logger.info('[agent] Waiting for user input', { question: decision.question });
        break;
      }

      await new Promise(r => setTimeout(r, 100));
    }

  } catch (e) {
    logger.error('[agent] Loop error', { error: e.message, step: state.step_count });
    state.status = AgentStatus.FAILED;
    state.final_result = `Agent loop error: ${e.message}`;
    state.errors.push({
      step: state.step_count,
      action: 'loop',
      message: e.message,
      timestamp: new Date().toISOString()
    });
  }

  logger.info('[agent] Loop complete', {
    id: state.id,
    status: state.status,
    steps: state.step_count,
    errors: state.errors.length
  });

  // Autonomous skill capture: after a SUCCESSFUL, multi-step task, distill a reusable
  // skill in the background (non-blocking, guarded). Single-step tasks are too trivial.
  try {
    if (process.env.AVA_SKILL_CAPTURE_OFF !== '1'
        && process.env.AVA_SANDBOX !== '1'
        && state.status === AgentStatus.SUCCESS
        && (state.step_count || 0) >= 3) {
      const transcript = (state.history || [])
        .map((h) => `${(h.type || 'step')}: ${JSON.stringify(h).slice(0, 300)}`)
        .slice(-20).join('\n');
      setTimeout(() => {
        skillCapture.reviewAndCapture({ goal: state.goal, transcript }).catch(() => {});
      }, 50);
    }
  } catch { /* never block the result */ }

  try { emitVoiceEvent('agent.state', { state: 'working.end', id: state.id, status: state.status }, 'agent'); } catch { /* ui push is best-effort */ }
  return state;
}

/**
 * Resume an agent that's waiting for user input
 */
async function resumeAgentLoop(state, userResponse) {
  if (state.status !== AgentStatus.WAITING_USER) {
    throw new Error(`Cannot resume agent in status: ${state.status}`);
  }

  logger.info('[agent] Resuming with user response', { id: state.id, response: userResponse.slice(0, 50) });

  state.current_context.user_response = userResponse;
  state.last_result = { status: 'user_response', response: userResponse };
  state.status = AgentStatus.RUNNING;

  return runAgentLoopFromState(state);
}

/**
 * Continue agent loop from existing state
 */
async function runAgentLoopFromState(state) {
  // Tier 2 #15: tell the UI explicitly when real work starts/ends, so it never has to
  // GUESS with idle timeouts (the client's old 15s "working" hack is gone).
  try { emitVoiceEvent('agent.state', { state: 'working.start', id: state.id, goal: String(state.goal || '').slice(0, 140) }, 'agent'); } catch { /* ui push is best-effort */ }
  try {
    while (shouldContinue(state)) {
      state.step_count++;

      const observations = await observe(state);
      const decision = await decide(state, observations);

      // Anti-spin guard: if the model picks a tool+args it ALREADY ran this loop, do
      // NOT re-run it — stop and use the prior result. Prevents the loop from calling
      // the same action repeatedly (e.g. open_item 7+ times) and burning all steps.
      if (decision && decision.decision === 'tool_call' && decision.tool) {
        const _sig = JSON.stringify(decision.args || {});
        const _prior = [...(state.history || [])].reverse().find(h => {
          const ht = h && ((h.decision && h.decision.tool) || (h.action && h.action.tool));
          const ha = (h && h.action && h.action.args) || (h && h.decision && h.decision.args) || {};
          return ht === decision.tool && JSON.stringify(ha) === _sig;
        });
        if (_prior && _prior.result) {
          const _ok = String(_prior.result.status || '').toLowerCase() === 'ok';
          state.last_result = _prior.result;
          state.status = _ok ? AgentStatus.SUCCESS : AgentStatus.FAILED;
          state.final_result = state.final_result || (_ok ? (_prior.result.message || 'Done.') : (_prior.result.message || _prior.result.error || "I couldn't complete that — my last tool didn't return a result."));
          logger.info('[agent] Anti-spin: repeated tool+args, stopping with prior result', { tool: decision.tool });
          break;
        }
      }

      const actionResult = await act(state, decision);
      await record(state, observations, decision, actionResult);

      // Tier 2 #14: per-step heartbeat for long-horizon supervisors (progress + stuck detection).
      if (state.onStep) { try { state.onStep(state, decision, actionResult); } catch { /* never break the loop */ } }

      // Scope: a single-action goal stops after the FIRST successful tool result, so the
      // loop doesn't tack on unrequested follow-up actions (e.g. take screenshot THEN open).
      if (!state._multiStep && decision && decision.decision === 'tool_call'
          && actionResult && actionResult.result
          && String(actionResult.result.status).toLowerCase() === 'ok') {
        state.status = AgentStatus.SUCCESS;
        if (!state.final_result) {
          if (INFO_TOOLS.has(decision.tool)) {
            const _syn = await synthesizeAnswer(state.goal, decision.tool, actionResult.result);
            state.final_result = _syn || actionResult.result.message || 'Done.';
          } else {
            state.final_result = actionResult.result.message || 'Done.';
          }
        }
        logger.info('[agent] Scope: single-action complete, stopping', { goal: String(state.goal).slice(0, 40) });
        break;
      }

      state.current_context.user_response = null;

      if (state.status === AgentStatus.WAITING_USER) {
        break;
      }

      await new Promise(r => setTimeout(r, 100));
    }
  } catch (e) {
    logger.error('[agent] Loop error', { error: e.message });
    state.status = AgentStatus.FAILED;
    state.final_result = `Agent loop error: ${e.message}`;
  }

  try { emitVoiceEvent('agent.state', { state: 'working.end', id: state.id, status: state.status }, 'agent'); } catch { /* ui push is best-effort */ }
  return state;
}

/**
 * Replay a task from stored history
 */
async function replayFromHistory(history, options = {}) {
  const dryRun = options.dryRun !== false;
  
  logger.info('[agent] Replaying from history', { steps: history.length, dryRun });

  const results = [];

  for (const entry of history) {
    const replayResult = {
      step: entry.step,
      original_action: entry.action,
      original_result: entry.result
    };

    if (dryRun) {
      replayResult.replay_result = { status: 'dry-run', message: 'Would execute: ' + (entry.action?.tool || entry.action?.type) };
    } else if (entry.action?.tool) {
      try {
        const result = await toolsService.executeTool(entry.action.tool, entry.action.args);
        replayResult.replay_result = result.result || result;
      } catch (e) {
        replayResult.replay_result = { status: 'error', message: e.message };
      }
    }

    results.push(replayResult);
  }

  return results;
}

// Store active agent states
const activeAgents = new Map();

function getAgent(agentId) {
  return activeAgents.get(agentId);
}

function storeAgent(state) {
  activeAgents.set(state.id, state);
  if (activeAgents.size > 100) {
    const oldest = Array.from(activeAgents.keys())[0];
    activeAgents.delete(oldest);
  }
}

export default {
  runAgentLoop,
  resumeAgentLoop,
  replayFromHistory,
  getAgent,
  storeAgent,
  AgentStatus,
  DecisionType,
  createAgentState,
  // Tier 1 #9: pure decision helpers exported for golden-path tests
  _internals: { parseDecisionJson, isMultiStepGoal, mapNativeDecision, buildNativeTools, _toolAllowed }
};
