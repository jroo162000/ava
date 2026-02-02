// Agent Routes - Endpoints for the unified control loop
// Phase 4: Observe → Decide → Act → Record → Loop
import express from 'express';
import logger from '../utils/logger.js';
import agentLoop from '../services/agentLoop.js';

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
 * Execute a single step (for debugging/manual control)
 * POST /agent/step
 * Body: { goal: string, state?: object }
 */
router.post('/agent/step', async (req, res) => {
  try {
    const { goal, state: existingState } = req.body;
    
    if (!goal && !existingState) {
      return res.status(400).json({ ok: false, error: 'Goal or existing state required' });
    }

    // Create or use existing state
    const state = existingState 
      ? { ...existingState, status: agentLoop.AgentStatus.RUNNING }
      : agentLoop.createAgentState(goal, { stepLimit: 1 });
    
    state.step_count++;

    // Execute single step
    const { observe, decide, act, record } = await import('../services/agentLoop.js').then(m => ({
      observe: m.default.observe || (async (s) => ({})),
      decide: m.default.decide || (async (s, o) => ({ decision: 'stop', result: 'Manual step', success: true })),
      act: m.default.act || (async (s, d) => ({ action: d, result: { status: 'ok' } })),
      record: m.default.record || (async () => {})
    }));

    // This is a simplified single-step execution for debugging
    // The full loop is in runAgentLoop
    
    res.json({
      ok: true,
      message: 'Use POST /agent/run for full execution',
      hint: 'Single-step mode is for debugging only'
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;
