import path from 'path';
import { fileURLToPath } from 'url';
import curiosity from '../src/services/curiositySupervisor.js';
import autonomyLib from '../src/services/autonomyPolicy.js';
import memoryService from '../src/services/memory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('CuriositySupervisor', () => {
  beforeAll(() => {
    // Ensure policy loads
    autonomyLib.getAutonomy();
  });

  test('blocks below relevance threshold', async () => {
    const res = await curiosity.run({
      trigger: 'gap_detected',
      domain: 'web_research',
      scopeMinutes: 5,
      plannedFindings: 1,
      signal: { relevanceScore: 0.2 },
      isUserInitiated: false, // background
      task: async () => ({ findings: [{ text: 'irrelevant text', relevanceScore: 0.2 }] })
    });
    expect(res.ran).toBe(false);
    expect(['log_only', 'notify', 'do_nothing']).toContain(res.outcome);
  });

  test('blocks on budgets exceeded', async () => {
    const autonomy = autonomyLib.getAutonomy();
    const budgets = autonomy.getBudgets();
    // Exhaust curiosity minutes
    budgets.spend('curiosityMinutes', autonomy.getPolicy().thresholds.curiosity_max_minutes_per_day);

    const res = await curiosity.run({
      trigger: 'explicit_research_request',
      domain: 'web_research',
      scopeMinutes: 5,
      plannedFindings: 1,
      signal: { relevanceScore: 0.9 },
      isUserInitiated: true,
      task: async () => ({ findings: [{ text: 'something relevant', relevanceScore: 0.95, url: 'http://example.com' }] })
    });
    expect(res.ran).toBe(false);
    expect(res.reason).toBe('budget_exceeded');
  });

  test('filters memory writes with no citation when required', async () => {
    const autonomy = autonomyLib.getAutonomy();
    // Reset budgets between tests
    autonomy.getBudgets().reset();
    // Reset budgets by moving windows — simulate by not exhausting
    const before = memoryService.getStats().count;
    const res = await curiosity.run({
      trigger: 'explicit_research_request',
      domain: 'web_research',
      scopeMinutes: 1,
      plannedFindings: 1,
      signal: { relevanceScore: 0.95 },
      isUserInitiated: true,
      task: async () => ({ findings: [{ text: 'Useful but missing citation', relevanceScore: 0.95 }] })
    });
    const after = memoryService.getStats().count;
    expect(res.ran).toBe(true);
    expect(res.storedCount).toBe(0);
    expect(after).toBe(before); // no new memory due to missing citation
  });

  test('never interrupts (curiosity)', async () => {
    const res = await curiosity.run({
      trigger: 'gap_detected',
      domain: 'web_research',
      scopeMinutes: 1,
      plannedFindings: 1,
      signal: { relevanceScore: 0.95 },
      isUserInitiated: false,
      task: async () => ({ findings: [] })
    });
    // If it ran, it would be act_then_report only when user initiated; otherwise it won't run
    if (res.decision && res.decision.ui) {
      expect(res.decision.ui.canInterrupt).toBe(false);
    }
  });
});
