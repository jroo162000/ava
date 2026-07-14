import { jest } from '@jest/globals';
import pythonWorker from '../src/services/pythonWorker.js';
import {
  extractProposalIdCandidate,
  findProposalById,
  handleSelfModVoice,
  isProposalDecisionDiscussion,
  isProposalRecommendationQuestion,
} from '../src/services/selfModVoice.js';

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

describe('proposal discussion versus mutation intent', () => {
  afterEach(() => jest.restoreAllMocks());

  test('recognizes questions about rejected proposals without weakening explicit commands', () => {
    expect(isProposalDecisionDiscussion('how will we fix the last rejected proposal')).toBe(true);
    expect(isProposalDecisionDiscussion('i asked a question how would we fix the last rejected proposal')).toBe(true);
    expect(isProposalDecisionDiscussion('tell me about the rejected proposal')).toBe(true);
    expect(isProposalDecisionDiscussion('reject proposal 75cc35e1')).toBe(false);
    expect(isProposalDecisionDiscussion('approved proposal 6377a424')).toBe(false);
  });

  test('recognizes natural recommendation questions AVa previously missed', () => {
    expect(isProposalRecommendationQuestion('how will we fix the last rejected proposal')).toBe(true);
    expect(isProposalRecommendationQuestion('what should we do about the last rejected proposal')).toBe(true);
  });

  test('answers the logged question from rejected history without rejecting another proposal', async () => {
    const selfMod = jest.spyOn(pythonWorker, 'selfMod').mockImplementation(async ({ action }) => {
      if (action === 'list_pending') {
        return { status: 'ok', pending: [{ id: '75cc35e1', status: 'pending', file: 'eventLedger.js' }] };
      }
      if (action === 'list_all') {
        return {
          status: 'ok',
          all: [
            { id: '75cc35e1', status: 'pending', file: 'eventLedger.js', created: '2026-07-14T09:30:00Z' },
            {
              id: '8d8d3022',
              status: 'rejected',
              file: 'olderRejection.js',
              reason: 'This proposal was created later but rejected earlier.',
              created: '2026-07-14T09:35:00Z',
              rejected_at: '2026-07-14T09:56:00Z',
            },
            {
              id: '6377a424',
              status: 'rejected',
              file: 'eventLedger.js',
              reason: 'Correct the decision provenance design.',
              created: '2026-07-14T09:15:00Z',
              metadata: { rejectedAt: '2026-07-14T10:54:00Z' },
            },
          ],
        };
      }
      throw new Error(`unexpected self-mod action: ${action}`);
    });

    const first = await handleSelfModVoice('how will we fix the last rejected proposal');
    const correction = await handleSelfModVoice('i asked a question how would we fix the last rejected proposal which was 63778 424');

    expect(first).toContain('6377a424');
    expect(first).not.toContain('8d8d3022');
    expect(correction).toContain('6377a424');
    expect(selfMod.mock.calls.some(([request]) => ['approve', 'reject'].includes(request.action))).toBe(false);
  });
});
