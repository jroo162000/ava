import { shouldRecordEvent } from '../src/services/eventLedger.js';

describe('event ledger signal filter', () => {
  it('drops repetitive environment polls and capability refresh notices', () => {
    expect(shouldRecordEvent({ type: 'tool.start', source: 'env', data: { tool: 'window_ops' } })).toBe(false);
    expect(shouldRecordEvent({ type: 'tool.result', source: 'env', data: { tool: 'sys_ops' } })).toBe(false);
    expect(shouldRecordEvent({ type: 'capabilities.updated', source: 'capabilities' })).toBe(false);
  });

  it('keeps user-task tool outcomes', () => {
    expect(shouldRecordEvent({ type: 'tool.result', source: 'agent', data: { tool: 'fs_read', ok: true } })).toBe(true);
  });
});
