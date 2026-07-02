// Agent Routes - Endpoints for the unified control loop
// Phase 4: Observe → Decide → Act → Record → Loop
import express from 'express';
import logger from '../utils/logger.js';
import agentLoop from '../services/agentLoop.js';
import subagentOrchestrator from '../services/subagentOrchestrator.js';
import subagentRoles from '../services/subagentRoles.js';

const router = express.Router();

/**
 * Start a new agent task
 * POST /agent/run
 * Body: { goal: string, options?: { stepLimit?: number, userInfo?: object } }
 */
router.post('/agent/run', async (req, res) => {
  try {
    const { goal, options = {} } = req.body;
    
    if (!goal || typeof goal !== 'string') {
      return res.status(400).json({ ok: false, error: 'Goal is required' });
    }

    logger.info('[agent-api] Starting new task', { goal: goal.slice(0, 100) });
    
    const state = await agentLoop.runAgentLoop(goal, options);
    
    // Store for potential resume
    agentLoop.storeAgent(state);
    
    res.json({
      ok: true,
      agent: {
        id: state.id,
        status: state.status,
        goal: state.goal,
        steps: state.step_count,
        result: state.final_result,
        errors: state.errors.length,
        history: state.history
      }
    });
  } catch (error) {
    logger.error('[agent-api] Run failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Resume an agent waiting for user input
 * POST /agent/:id/resume
 * Body: { response: string }
 */
router.post('/agent/:id/resume', async (req, res) => {
  try {
    const { id } = req.params;
    const { response } = req.body;
    
    if (!response) {
      return res.status(400).json({ ok: false, error: 'Response is required' });
    }

    const state = agentLoop.getAgent(id);
    if (!state) {
      return res.status(404).json({ ok: false, error: 'Agent not found' });
    }

    logger.info('[agent-api] Resuming agent', { id, status: state.status });
    
    const updatedState = await agentLoop.resumeAgentLoop(state, response);
    agentLoop.storeAgent(updatedState);
    
    res.json({
      ok: true,
      agent: {
        id: updatedState.id,
        status: updatedState.status,
        goal: updatedState.goal,
        steps: updatedState.step_count,
        result: updatedState.final_result,
        errors: updatedState.errors.length,
        history: updatedState.history
      }
    });
  } catch (error) {
    logger.error('[agent-api] Resume failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

/** Available subagent roles (each with a scoped toolset). GET /agent/roles
 *  NOTE: must be registered BEFORE GET /agent/:id, or ":id" would capture "roles". */
router.get('/agent/roles', (_req, res) => {
  res.json({ ok: true, roles: subagentRoles.listRoles() });
});

/** Create + SAVE a custom subagent role. POST /agent/roles  Body: {name, description, prompt, tools|allow, deny} */
router.post('/agent/roles', (req, res) => {
  try {
    const { name, description, prompt, tools, allow, deny } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    res.json(subagentRoles.createRole({ name, description, prompt, tools, allow, deny }));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/** Delete a custom subagent role (built-ins can't be deleted). DELETE /agent/roles/:name */
router.delete('/agent/roles/:name', (req, res) => { res.json(subagentRoles.deleteRole(req.params.name)); });

/** Recent subagent orchestration runs. GET /agent/orchestrations (also before /agent/:id). */
router.get('/agent/orchestrations', (_req, res) => {
  res.json({ ok: true, recent: subagentOrchestrator.recent(20) });
});

/**
 * Get agent status
 * GET /agent/:id
 */
router.get('/agent/:id', (req, res) => {
  try {
    const { id } = req.params;
    const state = agentLoop.getAgent(id);
    
    if (!state) {
      return res.status(404).json({ ok: false, error: 'Agent not found' });
    }

    res.json({
      ok: true,
      agent: {
        id: state.id,
        status: state.status,
        goal: state.goal,
        steps: state.step_count,
        step_limit: state.step_limit,
        result: state.final_result,
        errors: state.errors,
        last_action: state.last_action,
        last_result: state.last_result,
        created_at: state.created_at,
        updated_at: state.updated_at
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Get agent execution history
 * GET /agent/:id/history
 */
router.get('/agent/:id/history', (req, res) => {
  try {
    const { id } = req.params;
    const state = agentLoop.getAgent(id);
    
    if (!state) {
      return res.status(404).json({ ok: false, error: 'Agent not found' });
    }

    res.json({
      ok: true,
      agent_id: state.id,
      goal: state.goal,
      status: state.status,
      history: state.history
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Replay a task from history
 * POST /agent/replay
 * Body: { history: array, dryRun?: boolean }
 */
router.post('/agent/replay', async (req, res) => {
  try {
    const { history, dryRun = true } = req.body;
    
    if (!Array.isArray(history) || history.length === 0) {
      return res.status(400).json({ ok: false, error: 'History array is required' });
    }

    logger.info('[agent-api] Replaying from history', { steps: history.length, dryRun });
    
    const results = await agentLoop.replayFromHistory(history, { dryRun });
    
    res.json({
      ok: true,
      replay: {
        steps: results.length,
        dry_run: dryRun,
        results
      }
    });
  } catch (error) {
    logger.error('[agent-api] Replay failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});


/**
 * LEAD AGENT — decompose a goal into subtasks, spawn subagents (each its own loop) in parallel,
 * collect results, and synthesize. AVA is the lead. POST /agent/orchestrate
 * Body: { goal: string, subtasks?: [{role,goal}], sharedContext?: string, synthesize?: boolean }
 */
router.post('/agent/orchestrate', async (req, res) => {
  try {
    const { goal, subtasks, sharedContext, synthesize } = req.body || {};
    if ((!goal || String(goal).trim().length < 3) && !(Array.isArray(subtasks) && subtasks.length)) {
      return res.status(400).json({ ok: false, error: 'Provide a goal (and/or explicit subtasks).' });
    }
    logger.info('[agent-api] Orchestrating (lead + subagents)', { goal: String(goal || '').slice(0, 100), subtasks: Array.isArray(subtasks) ? subtasks.length : 'auto' });
    res.json(await subagentOrchestrator.orchestrate({ goal, subtasks, sharedContext, synthesize: synthesize !== false }));
  } catch (error) {
    logger.error('[agent-api] Orchestrate failed', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;
