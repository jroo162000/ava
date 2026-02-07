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
import autonomyLib from './autonomyPolicy.js';
import memoryService, { MemoryType, MemorySource } from './memory.js';
import curiosity from './curiositySupervisor.js';
import digestQueue from './digestQueue.js';
import { jaccardSim } from './curiosityScoring.js';
import llmService from './llm.js';
import moltbookScheduler from './moltbookScheduler.js';

// Agent state constants
const DEFAULT_STEP_LIMIT = 12;
const MAX_STEP_LIMIT = 25;
const MAX_CONSECUTIVE_ERRORS = 3;

/**
 * Decision types returned by LLM
 */
const DecisionType = {
  TOOL_CALL: 'tool_call',
  ASK_USER: 'ask_user',
  STOP: 'stop'
};

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
function createAgentState(goal, options = {}) {
  return {
    id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    goal,
    status: AgentStatus.RUNNING,
    step_count: 0,
    step_limit: Math.min(options.stepLimit || DEFAULT_STEP_LIMIT, MAX_STEP_LIMIT),
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
    memoryFilter: options.memoryFilter || null,
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

    // VALIDATION MODE: restrict memory to facts only — no workflows/agent actions
    const memoryTypes = state.memoryFilter === 'facts_only'
      ? [MemoryType.FACT, MemoryType.PREFERENCE, MemoryType.CONSTRAINT]
      : [MemoryType.PREFERENCE, MemoryType.WORKFLOW, MemoryType.CONSTRAINT,
         MemoryType.FACT, MemoryType.WARNING, MemoryType.AGENT_ACTION];

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
function buildDecisionPrompt(state, observations) {
  const toolDescriptions = state.toolset.map(t => 
    `- ${t.name}: ${t.description}${t.requires_confirm ? ' [REQUIRES confirmed:true]' : ''}${t.risk_level === 'high' ? ' [HIGH RISK]' : ''}`
  ).join('\n');

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

  return `You are AVA, an intelligent assistant executing a task step by step.

GOAL: ${state.goal}

CURRENT STATE:
- Step: ${state.step_count + 1} of ${state.step_limit}
- Status: ${state.status}
${state.last_result ? `- Last result: ${JSON.stringify(state.last_result).slice(0, 200)}` : ''}
${historyContext}
${errorContext}
${userResponseContext}
${pendingContext}
${memoryContext ? '\n' + memoryContext : ''}

AVAILABLE TOOLS:
${toolDescriptions}

RESPOND WITH EXACTLY ONE JSON OBJECT (no markdown, no explanation):

For tool execution:
{"decision": "tool_call", "tool": "tool_name", "args": {...}, "reasoning": "why this action"}

For clarification needed:
{"decision": "ask_user", "question": "what you need to know", "reasoning": "why you need this"}

For task complete:
{"decision": "stop", "result": "summary of what was accomplished", "success": true/false}

CRITICAL RULES:
1. Execute ONE tool at a time
2. If a tool failed, try an alternative approach  
3. If you lack information, ask the user
4. After ${state.step_limit} steps, you must stop
5. **IMPORTANT**: Tools marked [REQUIRES confirmed:true] MUST have {"confirmed": true} in args
6. If last result was "needs_confirm" and user confirmed, retry with confirmed:true in args
7. The open_item tool uses "target" not "path" for its argument
8. **USE MEMORY**: If RELEVANT_MEMORY contains useful info, apply it to your decision

What is your next action?`;
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

  const prompt = buildDecisionPrompt(state, observations);

  try {
    const response = await llmService.chat([
      { role: 'system', content: 'You are a task execution agent. Respond only with valid JSON.' },
      { role: 'user', content: prompt }
    ], {
      temperature: 0.3,
      max_tokens: 500
    });

    const text = response.text || response.content || '';
    
    let jsonStr = text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    const decision = JSON.parse(jsonStr);
    
    if (!decision.decision || !Object.values(DecisionType).includes(decision.decision)) {
      throw new Error(`Invalid decision type: ${decision.decision}`);
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
        
        const tool = await toolsService.getTool(decision.tool);
        if (!tool) {
          result = { status: 'error', message: `Tool not found: ${decision.tool}` };
          break;
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

        logger.info('[agent] Executing tool', { tool: decision.tool, args: action.args });
        const toolResult = await toolsService.executeTool(decision.tool, action.args);
        result = toolResult.result || toolResult;
        try {
          const { getAutonomy } = autonomyLib; const autonomy = getAutonomy(logger);
          autonomy.recordOutcome('act_then_report');
        } catch {}
        
        if (result.status === 'ok') {
          state.current_context.pending_confirmation = null;
        }
        break;

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
      await memoryService.store({
        text: `Warning: ${decision.tool || 'action'} failed with: ${lastError.message}. Avoid this approach for: ${state.goal.slice(0, 50)}`,
        type: MemoryType.WARNING,
        priority: 4,
        source: MemorySource.LEARNED,
        tags: ['warning', 'error', decision.tool || 'unknown']
      });

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

    // Automatic learning: store constraints on denials/whitelist/confirmation issues
    const denialLike = status === 'denied' || /not in whitelist|requires confirmation|confirmation required|blocked|forbidden/i.test(message);
    const errorLike = status === 'error' && /whitelist|confirm|not found|not a directory|missing/i.test(message);
    if ((denialLike || errorLike) && toolName) {
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

  try {
    while (shouldContinue(state)) {
      state.step_count++;

      const observations = await observe(state);
      const decision = await decide(state, observations);
      const actionResult = await act(state, decision);
      await record(state, observations, decision, actionResult);

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
  try {
    while (shouldContinue(state)) {
      state.step_count++;

      const observations = await observe(state);
      const decision = await decide(state, observations);
      const actionResult = await act(state, decision);
      await record(state, observations, decision, actionResult);

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
  createAgentState
};
