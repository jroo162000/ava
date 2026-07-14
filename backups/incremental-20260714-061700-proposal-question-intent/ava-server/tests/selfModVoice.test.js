import { extractProposalIdCandidate, findProposalById } from '../src/services/selfModVoice.js';

describe('spoken proposal identifiers', () => {
  const pending = [
    { id: '6377a424', status: 'pending' },
    { id: '75cc35e1', status: 'pending' },
  ];

  test('reassembles a hexadecimal ID split apart by speech recognition', () => {
    expect(extractProposalIdCandidate('approve 637 7a 424')).toBe('6377a424');
    expect(findProposalById(pending, '6377a424')).toBe(pending[0]);
  });

  test('keeps a misheard explicit ID explicit instead of selecting a newer proposal', () => {
    const heard = extractProposalIdCandidate('approve proposal 637 7 8 424');
    expect(heard).toBe('63778424');
    expect(findProposalById(pending, heard)).toBeNull();
  });

  test('accepts a unique six-character prefix but never an ambiguous short token', () => {
    expect(findProposalById(pending, '75cc35')).toBe(pending[1]);
    expect(findProposalById(pending, '637')).toBeNull();
  });
});
