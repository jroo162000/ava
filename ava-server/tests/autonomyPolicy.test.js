// Autonomy Policy Tests (ESM)
import path from 'path';
import { fileURLToPath } from 'url';
import { AutonomyPolicy, estimateUrgency } from '../src/services/autonomyPolicy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('AutonomyPolicy', () => {
  const policyPath = path.join(__dirname, '..', 'policies', 'autonomy_policy.json');
  const schemaPath = path.join(__dirname, '..', 'policies', 'autonomy_policy.schema.json');

  test('loads and validates policy', () => {
    const ap = new AutonomyPolicy({ policyPath, schemaPath, logger: { info: () => {} } });
    expect(() => ap.load()).not.toThrow();
    expect(ap.getPolicy().version).toBeGreaterThanOrEqual(1);
  });

  test('responsibility trigger can ask_permission at high urgency', () => {
    const ap = new AutonomyPolicy({ policyPath, schemaPath, logger: { info: () => {} } });
    ap.load();
    const res = ap.decide({
      domain: 'system_health',
      trigger: 'health_degrade',
      signal: { impact: 4, timeSensitivity: 3, confidence: 2, disruptionCost: 0.1 },
      risk: { toolRisk: 'medium' },
      requiresWrite: false,
      isUserInitiated: false
    });
    expect(['ask_permission', 'notify']).toContain(res.outcome);
    expect(res.urgency).toBeGreaterThanOrEqual(7);
  });

  test('curiosity never interrupts and requires relevance threshold', () => {
    const ap = new AutonomyPolicy({ policyPath, schemaPath, logger: { info: () => {} } });
    ap.load();
    const lowRel = ap.decide({
      domain: 'web_research',
      trigger: 'gap_detected',
      signal: { impact: 1, timeSensitivity: 0, confidence: 1, disruptionCost: 0.9, relevanceScore: 0.2 },
      risk: { toolRisk: 'low' },
      requiresWrite: false,
      isUserInitiated: false
    });
    expect(lowRel.outcome).toBe('log_only');

    const hiRel = ap.decide({
      domain: 'web_research',
      trigger: 'gap_detected',
      signal: { impact: 1, timeSensitivity: 0, confidence: 1, disruptionCost: 0.9, relevanceScore: 0.9, curiosityMinutes: 5 },
      risk: { toolRisk: 'low' },
      requiresWrite: false,
      isUserInitiated: false
    });
    expect(['notify', 'log_only']).toContain(hiRel.outcome);
    expect(hiRel.ui.canInterrupt).toBe(false);
  });

  test('high risk always forces ask_permission', () => {
    const ap = new AutonomyPolicy({ policyPath, schemaPath, logger: { info: () => {} } });
    ap.load();
    const res = ap.decide({
      domain: 'dev_maintenance',
      trigger: 'error_repeat',
      signal: { impact: 3, timeSensitivity: 2, confidence: 2, disruptionCost: 0.2 },
      risk: { toolRisk: 'high', category: 'system_commands' },
      requiresWrite: true,
      isUserInitiated: true
    });
    expect(res.outcome).toBe('ask_permission');
  });

  test('estimateUrgency is bounded 0..10', () => {
    const u = estimateUrgency({ triggerBase: 5, impact: 10, timeSensitivity: 10, confidence: 10, disruptionCost: -2 });
    expect(u).toBeLessThanOrEqual(10);
    expect(u).toBeGreaterThanOrEqual(0);
  });
});

