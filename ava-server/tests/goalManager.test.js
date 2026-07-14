import { jest } from '@jest/globals';
import goalManager from '../src/services/goalManager.js';
import workflowEngine from '../src/services/workflowEngine.js';

const {
  isConversationOnly,
  shouldClassify,
  selectWorkflowTargets,
} = goalManager._internals;

describe('goal manager conversation routing', () => {
  test('keeps the logged upgrade-reflection request out of the workflow engine', () => {
    const text = 'you just had a long run of upgrades completed tell me what you think about them some more are coming in now';
    expect(isConversationOnly(text)).toBe(true);
    expect(shouldClassify(text)).toBe(false);
  });

  test('does not hide requested work behind the dialogue guard', () => {
    const text = 'Tell me what you think about these changes, then inspect the failures and fix what is broken.';
    expect(isConversationOnly(text)).toBe(false);
    expect(shouldClassify(text)).toBe(true);
  });

  test('still classifies broad long-horizon work', () => {
    expect(shouldClassify('Run a full audit of the entire repo and implement all verified recommendations from start to finish.')).toBe(true);
  });
});

describe('goal manager workflow target routing', () => {
  const rows = [
    {
      id: 'wf-sys',
      status: 'waiting_user',
      goal: 'Determine why sys_ops tool is registered but not callable',
      currentStage: 'Inspect tool registry directly',
      pendingQuestion: 'Do you approve this exact action?',
      updatedAt: 200,
    },
    {
      id: 'wf-window',
      status: 'waiting_user',
      goal: 'Determine why window_ops tool is registered but returns Tool not found',
      currentStage: 'Check Tool Registry Configuration',
      pendingQuestion: 'Do you approve this exact action?',
      updatedAt: 100,
    },
    {
      id: 'wf-window-old',
      status: 'failed',
      goal: 'Diagnose an older window_ops failure',
      currentStage: '',
      pendingQuestion: '',
      updatedAt: 300,
    },
  ];

  afterEach(() => jest.restoreAllMocks());

  test('selects only the active named workflows from the logged speech variants', () => {
    const both = selectWorkflowTargets(
      'continue the workflows dealing with window options system ops',
      rows,
    );
    expect(both.map(row => row.id)).toEqual(['wf-window', 'wf-sys']);

    const window = selectWorkflowTargets(
      'i m talking about the workflow that starts with determine why windows ops',
      rows,
    );
    expect(window.map(row => row.id)).toEqual(['wf-window']);
  });

  test('uses the last workflow prompt to route a bare yes', () => {
    const targets = selectWorkflowTargets('yes', rows, {
      lastAssistant: 'I need your input to continue "Determine why sys_ops tool is registered but not callable": Do you approve this exact action?',
    });
    expect(targets.map(row => row.id)).toEqual(['wf-sys']);
  });

  test('applies the logged approval to both waiting workflows', async () => {
    jest.spyOn(workflowEngine, 'list').mockReturnValue(rows);
    const provideInput = jest.spyOn(workflowEngine, 'provideInput')
      .mockImplementation(id => ({ ok: true, id, status: 'resuming' }));

    const result = await goalManager.handleTurn(
      'both workflows say waiting for user you are approved to move forward with both workflows',
      { sessionId: 'workflow-routing-test', channel: 'voice' },
    );

    expect(result.handled).toBe(true);
    expect(result.text).toMatch(/resumed sys_ops and window_ops/i);
    expect(provideInput.mock.calls.map(([id]) => id)).toEqual(['wf-sys', 'wf-window']);
  });
});
