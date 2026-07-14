import { formatLearningSynthesis, synthesizeLearnings } from '../src/services/learningSynthesis.js';

describe('Moltbook learning synthesis', () => {
  test('duplicate records do not inflate themes, keywords, sources, or actionable examples', () => {
    const repeated = {
      title: 'Cache invalidation needs evidence',
      summary: 'Reliable cache invalidation requires verification and failure receipts.',
      submolt: 'agentstack',
    };
    const distinct = {
      title: 'Voice presence depends on turn taking',
      summary: 'Natural voice presence benefits from careful turn taking and interruption handling.',
      submolt: 'voice',
    };
    const single = synthesizeLearnings([repeated, distinct]);
    const duplicated = synthesizeLearnings([
      ...Array.from({ length: 100 }, () => ({ ...repeated })),
      distinct,
    ]);

    expect(duplicated.totalInput).toBe(101);
    expect(duplicated.uniqueCount).toBe(2);
    expect(duplicated.duplicateCount).toBe(99);
    expect(duplicated.themes).toEqual(single.themes);
    expect(duplicated.keywords).toEqual(single.keywords);
    expect(duplicated.sources).toEqual(single.sources);
    expect(duplicated.actionableExamples).toEqual(single.actionableExamples);
  });

  test('counts a parent title once while retaining every distinct comment insight', () => {
    const title = 'Deterministic agent loops turn delegated permissions into supply chain risk';
    const thread = [
      {
        postId: 'thread-1',
        title,
        summary: 'The root post asks how delegated authority should be constrained.',
        submolt: 'agentstack',
      },
      ...Array.from({ length: 100 }, (_, index) => ({
        postId: 'thread-1',
        commentId: `comment-${index}`,
        title,
        summary: `Comment variation ${index} contributes a distinct operational observation about verification.`,
        submolt: 'agentstack',
      })),
      {
        postId: 'thread-2',
        title: 'Voice presence depends on careful turn taking',
        summary: 'Interruption handling changes whether a spoken exchange feels coherent.',
        submolt: 'voice',
      },
    ];

    const summary = synthesizeLearnings(thread);
    const repeatedTitleTheme = summary.themes.find(theme => theme.name === 'delegated permissions');

    expect(summary.totalInput).toBe(102);
    expect(summary.uniqueCount).toBe(102);
    expect(summary.parentCount).toBe(2);
    expect(repeatedTitleTheme?.count).toBe(1);
    expect(summary.sources).toEqual([
      { name: 'agentstack', count: 1 },
      { name: 'voice', count: 1 },
    ]);
    expect(summary.stratifiedExamples.filter(example => example.includes(title))).toHaveLength(1);
    expect(summary.stratifiedExamples.some(example => /Comment variation/.test(example))).toBe(true);
  });

  test('preserves actionable, corpus-wide, and recent evidence inside a bounded prompt', () => {
    const output = formatLearningSynthesis({
      totalInput: 10000,
      uniqueCount: 9980,
      duplicateCount: 20,
      parentCount: 5121,
      corpusHash: 'balanced-corpus',
      themes: Array.from({ length: 20 }, (_, index) => ({ name: `theme-${index}`, count: 20 - index })),
      sources: [{ name: 'agentstack', count: 100 }],
      actionableExamples: ['ACTIONABLE-ONE verifies a concrete failure receipt before a retry.', 'A'.repeat(500)],
      stratifiedExamples: ['STRATIFIED-ONE preserves a distinct idea from the middle of the corpus.', 'B'.repeat(500)],
      recentExamples: ['RECENT-ONE captures a newly observed community discussion.', 'C'.repeat(500)],
    }, 1200);

    expect(output.length).toBeLessThanOrEqual(1200);
    expect(output).toMatch(/ACTIONABLE-ONE/);
    expect(output).toMatch(/STRATIFIED-ONE/);
    expect(output).toMatch(/RECENT-ONE/);
  });
});
