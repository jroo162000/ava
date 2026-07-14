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

describe('workflowEngine durable user-input checkpoints', () => {
  const classify = workflowEngine._internals._classifyAgentOutcome;
  const resumeBlock = workflowEngine._internals._resumeInputBlock;
  const applyInput = workflowEngine._internals._applyWorkflowInput;

  test('an explicit ask_user outcome pauses instead of failing verification', () => {
    const outcome = classify({
      status: agentLoop.AgentStatus.WAITING_USER,
      last_action: { question: 'Which account should I use?' },
      current_context: { pending_confirmation: null },
    });
    expect(outcome).toEqual({ kind: 'waiting_user', question: 'Which account should I use?' });
  });

  test('a pending tool confirmation pauses even if the loop ended in another status', () => {
    const outcome = classify({
      status: agentLoop.AgentStatus.STEP_LIMIT,
      current_context: { pending_confirmation: { tool: 'comm_ops', args: { action: 'send' } } },
    });
    expect(outcome.kind).toBe('waiting_user');
    expect(outcome.question).toMatch(/permission to use "comm_ops"/);
    expect(outcome.question).toMatch(/approve this exact action/i);
  });

  test('resume prompt carries the exact question, answer, and prior journal', () => {
    const block = resumeBlock({
      resumeInput: { question: 'Post this update?', response: 'Yes, post that exact draft.' },
      progress: [{ step: 2, tool: 'moltbook_read', status: 'ok', note: 'loaded thread' }],
    });
    expect(block).toMatch(/PAUSED FOR USER INPUT/);
    expect(block).toContain('Post this update?');
    expect(block).toContain('Yes, post that exact draft.');
    expect(block).toMatch(/step 2: moltbook_read -> ok/);
    expect(block).toMatch(/Verify any prior side effects/);
    expect(block).toMatch(/do not blindly repeat/i);
  });

  test('an answer transitions only the waiting stage back to pending', () => {
    const wf = {
      id: 'wf-test', status: 'waiting_user', currentStage: 1, waitingStage: 1,
      pendingQuestion: 'Approve the send?', error: '', log: [],
      stages: [
        { title: 'Inspect', status: 'done' },
        { title: 'Send', status: 'waiting_user', pendingQuestion: 'Approve the send?', error: 'old' },
      ],
    };
    const result = applyInput(wf, 'Approved for that message.');
    expect(result).toMatchObject({ ok: true, status: 'resuming', stageIndex: 1 });
    expect(wf.status).toBe('running');
    expect(wf.stages[0].status).toBe('done');
    expect(wf.stages[1].status).toBe('pending');
    expect(wf.stages[1].resumeInput).toMatchObject({
      question: 'Approve the send?', response: 'Approved for that message.',
    });
    expect(wf.pendingQuestion).toBe('');
    expect(wf.waitingStage).toBeNull();
  });

  test('input is rejected when empty or when no stage is waiting', () => {
    expect(applyInput({ status: 'waiting_user', stages: [] }, '  ').error).toBe('response required');
    expect(applyInput({ status: 'running', stages: [] }, 'yes').error).toMatch(/not waiting/);
  });
});

describe('workflowEngine stage verification', () => {
  const normalize = workflowEngine._internals._normalizeStageVerdict;
  const successfulState = { status: agentLoop.AgentStatus.SUCCESS };
  const substantiveResult = 'AVa assessed the recent changes, identified the strongest improvements, and explained the remaining reliability tradeoffs in concrete detail.';

  test('accepts a successful no-tool stage when the only objection is empty receipts', () => {
    const verdict = normalize(
      { needsTools: false }, successfulState, substantiveResult, [],
      { accepted: false, reason: 'There are no tool receipts or external evidence to verify the response.' },
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.reason).toMatch(/explicitly required no tools/i);
  });

  test('does not override a substantive postcondition failure', () => {
    const verdict = normalize(
      { needsTools: false }, successfulState, substantiveResult, [],
      { accepted: false, reason: 'The result did not address the requested comparison.' },
    );
    expect(verdict.accepted).toBe(false);
  });

  test('does not relax receipt requirements for tool stages', () => {
    const verdict = normalize(
      { needsTools: true }, successfulState, substantiveResult, [],
      { accepted: false, reason: 'No successful tool receipts were provided.' },
    );
    expect(verdict.accepted).toBe(false);
  });

  test('does not accept a generic no-tool completion phrase', () => {
    const verdict = normalize(
      { needsTools: false }, successfulState, 'Completed.', [],
      { accepted: false, reason: 'There is no evidence or receipt supporting completion.' },
    );
    expect(verdict.accepted).toBe(false);
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
      expect(r).toHaveProperty('pendingQuestion');
    }
  });
});
