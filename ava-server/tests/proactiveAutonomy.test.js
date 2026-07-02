// proactiveAutonomy tests — Tier 3 #22. Pure-logic checks: which openings warrant an
// autonomous read-only investigation, and the store/pending shape. (The live read-only gate +
// end-to-end workflow are verified separately against the running server.)
import proactiveAutonomy from '../src/services/proactiveAutonomy.js';

const { investigationFor } = proactiveAutonomy._internals;

describe('proactiveAutonomy.investigationFor', () => {
  test('RAM pressure warrants a read-only investigation goal', () => {
    const inv = investigationFor({ key: 'env:ram', text: 'RAM tight' });
    expect(inv).toBeTruthy();
    expect(inv.goal).toMatch(/READ-ONLY/);
    expect(inv.goal).toMatch(/NO action|change nothing/i);
    expect(inv.goal.toLowerCase()).toMatch(/close/); // recommends closing, but tells it not to
  });

  test('Downloads pile-up warrants a read-only investigation goal', () => {
    const inv = investigationFor({ key: 'env:downloads', text: 'Downloads piling up' });
    expect(inv).toBeTruthy();
    expect(inv.goal).toMatch(/READ-ONLY/);
    expect(inv.goal.toLowerCase()).toMatch(/do not (move|delete)|delete anything/);
  });

  test('reflections and uptime nudges are NOT auto-investigated (left to the conversational layer)', () => {
    expect(investigationFor({ key: 'reflect:abc', text: 'i wonder about my design' })).toBeNull();
    expect(investigationFor({ key: 'env:uptime', text: 'up 9 days' })).toBeNull();
    expect(investigationFor(null)).toBeNull();
    expect(investigationFor({})).toBeNull();
  });

  test('list() and pending() return arrays without throwing', () => {
    expect(Array.isArray(proactiveAutonomy.list())).toBe(true);
    expect(Array.isArray(proactiveAutonomy.pending())).toBe(true);
  });
});
