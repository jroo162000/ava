// Tier 2 #14 — long-horizon autonomy: deadline/heartbeat hooks + crash-recovery prompt injection.
// Pure-function tests only: nothing here starts a workflow or touches data/workflows.json state
// beyond reads via list()/get()/abort() of a nonexistent id.
import { jest } from '@jest/globals';

const agentLoop = (await import('../src/services/agentLoop.js')).default;
const workflowEngine = (await import('../src/services/workflowEngine.js')).default;

describe('agentLoop long-horizon hooks (Tier 2 #14)', () => {
  test('createAgentState carries deadlineAt and onStep when provided', () => {
    const cb = () => {};
    const state = agentLoop.createAgentState('test goal', { deadlineAt: 12345, onStep: cb });
    expect(state.deadline_at).toBe(12345);
    expect(state.onStep).toBe(cb);
  });

  test('createAgentState defaults: no deadline, no onStep (unchanged legacy behavior)', () => {
    const state = agentLoop.createAgentState('test goal', {});
    expect(state.deadline_at).toBe(0);
    expect(state.onStep).toBeNull();
  });

  test('invalid deadlineAt values are ignored', () => {
    expect(agentLoop.createAgentState('g', { deadlineAt: 'soon' }).deadline_at).toBe(0);
    expect(agentLoop.createAgentState('g', { deadlineAt: -5 }).deadline_at).toBe(0);
  });
});

describe('workflowEngine crash-recovery injection (Tier 2 #14)', () => {
  const block = workflowEngine._internals._priorProgressBlock;

  test('no injection for a stage that was not interrupted', () => {
    expect(block({ interrupted: false, progress: [{ step: 1, tool: 'fs_ops', status: 'ok' }] })).toBe('');
  });

  test('no injection when there is no recorded progress', () => {
    expect(block({ interrupted: true, progress: [] })).toBe('');
  });

  test('interrupted stage with progress injects the verify-not-redo block', () => {
    const s = block({
      interrupted: true,
      progress: [
        { step: 1, tool: 'comm_ops', status: 'ok', note: 'sent email to X' },
        { step: 2, tool: 'fs_ops', status: 'error', note: 'permission denied' },
      ],
    });
    expect(s).toMatch(/INTERRUPTED BY A RESTART/);
    expect(s).toMatch(/step 1: comm_ops -> ok/);
    expect(s).toMatch(/step 2: fs_ops -> error/);
    expect(s).toMatch(/Do NOT blindly repeat/);
    expect(s).toMatch(/VERIFY/);
  });

  test('progress lines are bounded to the last 12 entries', () => {
    const progress = Array.from({ length: 30 }, (_, i) => ({ step: i + 1, tool: 't' + (i + 1), status: 'ok' }));
    const s = block({ interrupted: true, progress });
    expect(s).not.toMatch(/step 18:/);
    expect(s).toMatch(/step 19: t19/);
    expect(s).toMatch(/step 30: t30/);
  });
});

describe('workflowEngine control surface (Tier 2 #14)', () => {
  test('abort of an unknown workflow reports not found', () => {
    expect(workflowEngine.abort('wf-does-not-exist').ok).toBe(false);
  });

  test('list() exposes supervisor verdict and current stage fields', () => {
    const rows = workflowEngine.list();
    for (const r of rows) {
      expect(r).toHaveProperty('supervisor');
      expect(r).toHaveProperty('currentStage');
    }
  });
});
