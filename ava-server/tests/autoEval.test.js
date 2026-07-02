// autoEval tests — Tier 3 #21 (auto A/B). The keep-vs-revert decision is the safety-critical
// core, so it's pure + deterministically tested. (The full apply→restart→measure loop is
// verified live against the running server.)
import autoEval from '../src/services/autoEval.js';

describe('autoEval.decide (keep-if-better)', () => {
  const M = 0.125; // one task of eight

  test('an improvement is kept (flagged improved)', () => {
    expect(autoEval.decide(0.75, 1.0, M).outcome).toBe('kept_improved');
  });

  test('an identical score is kept', () => {
    expect(autoEval.decide(1.0, 1.0, M).outcome).toBe('kept');
  });

  test('a drop within the margin is tolerated (noise), kept', () => {
    // 1/8 = 0.125 drop is exactly the margin — still kept (not worse than -margin).
    expect(autoEval.decide(1.0, 0.875, M).outcome).toBe('kept');
  });

  test('a drop BEYOND the margin is a revert', () => {
    // two tasks lost = 0.25 drop
    expect(autoEval.decide(1.0, 0.75, M).outcome).toBe('revert');
  });

  test('no baseline never reverts (fail-safe: keep)', () => {
    expect(autoEval.decide(null, 0.5, M).outcome).toBe('kept');
    expect(autoEval.decide(undefined, 0.2, M).outcome).toBe('kept');
  });

  test('list() returns an array without throwing', () => {
    expect(Array.isArray(autoEval.list())).toBe(true);
  });
});
