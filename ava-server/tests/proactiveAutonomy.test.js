import proactiveAutonomy from '../src/services/proactiveAutonomy.js';
import { isActionableToolFailureEvent } from '../src/services/proactiveEngine.js';

const { investigationFor } = proactiveAutonomy._internals;
const registry = {
  refresh: async () => ({}),
  find: () => [{ name: 'system_read', risk: 'low', requiresConfirmation: false }],
  promptBlock: () => 'system_read: registered read-only system inspection capability',
};

describe('proactiveAutonomy.investigationFor', () => {
  test('builds a read-only investigation from the live registry and planner verdict', async () => {
    const chat = async () => ({ content: JSON.stringify({
      investigate: true,
      goal: 'Inspect current memory pressure with registered read-only tools and change nothing.',
      done_when: 'Current process and memory evidence has been collected.',
    }) });
    const inv = await investigationFor({ key: 'environment-observation', text: 'Memory pressure is elevated' }, { registry, chat });
    expect(inv).toEqual({
      goal: 'Inspect current memory pressure with registered read-only tools and change nothing.',
      doneWhen: 'Current process and memory evidence has been collected.',
    });
  });

  test('does not investigate when the planner says evidence gathering is unnecessary', async () => {
    const chat = async () => ({ content: '{"investigate":false,"goal":"","done_when":""}' });
    await expect(investigationFor({ key: 'reflection', text: 'A passing thought' }, { registry, chat })).resolves.toBeNull();
  });

  test('invalid observations are ignored before a model call', async () => {
    await expect(investigationFor(null, { registry })).resolves.toBeNull();
    await expect(investigationFor({}, { registry })).resolves.toBeNull();
  });

  test('list() and pending() return arrays without throwing', () => {
    expect(Array.isArray(proactiveAutonomy.list())).toBe(true);
    expect(Array.isArray(proactiveAutonomy.pending())).toBe(true);
  });
});

describe('proactive tool-failure intake', () => {
  test('ignores best-effort environment polling misses during worker warm-up', () => {
    expect(isActionableToolFailureEvent({
      type: 'tool.result', source: 'env', data: { ok: false, tool: 'window_ops', summary: 'Tool not found' },
    })).toBe(false);
  });

  test('keeps real user and workflow tool failures actionable', () => {
    expect(isActionableToolFailureEvent({
      type: 'tool.result', source: 'workflow', data: { ok: false, tool: 'window_ops', summary: 'backend error' },
    })).toBe(true);
    expect(isActionableToolFailureEvent({
      type: 'tool.result', source: 'voice', data: { ok: true, tool: 'camera_ops' },
    })).toBe(false);
  });
});
