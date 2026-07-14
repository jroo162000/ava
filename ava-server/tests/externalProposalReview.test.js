import { _internals } from '../src/services/externalProposalReview.js';

describe('external proposal review receipts', () => {
  const request = { requestId: 'mod-123-deadbeef', modificationId: 'mod-123' };

  test('accepts an evidence-grounded approve or deny verdict with matching IDs', () => {
    const review = _internals.normalizeResult({
      requestId: request.requestId,
      modificationId: request.modificationId,
      model: 'gpt-test',
      recommendation: 'approve',
      reason: 'The diff uses existing exports and preserves the approval boundary.',
      evidence: ['The imported function exists in the target module.'],
    }, request);
    expect(review.reviewer).toBe('codex-task');
    expect(review.recommendation).toBe('approve');
    expect(review.evidence).toHaveLength(1);
  });

  test('rejects mismatched IDs and non-decisive verdicts', () => {
    expect(() => _internals.normalizeResult({
      requestId: 'wrong', modificationId: request.modificationId,
      recommendation: 'deny', reason: 'This reason is long enough to satisfy evidence validation.',
    }, request)).toThrow(/requestId/);
    expect(() => _internals.normalizeResult({
      requestId: request.requestId, modificationId: request.modificationId,
      recommendation: 'review', reason: 'This reason is long enough to satisfy evidence validation.',
    }, request)).toThrow(/approve or deny/);
  });

  test('derives stable request IDs from proposal identity and diff', () => {
    expect(_internals.requestIdFor('abc', 'same diff')).toBe(_internals.requestIdFor('abc', 'same diff'));
    expect(_internals.requestIdFor('abc', 'same diff')).not.toBe(_internals.requestIdFor('abc', 'different diff'));
  });

  test('recognizes stale proposal outcomes as terminal receipt states', () => {
    expect(_internals.terminalProposalStatus({ message: 'Modification already rejected' })).toBe('rejected');
    expect(_internals.terminalProposalStatus({ message: 'Modification already applied' })).toBe('applied');
    expect(_internals.terminalProposalStatus({ message: 'Modification abc not found' })).toBe('not_found');
    expect(_internals.terminalProposalStatus({ message: 'Python worker unavailable' })).toBeNull();
  });
});
