import {
  sanitizeForMoltbook,
  validateSelfPostDraft,
  validateMoltbookPeerText,
  semanticPostSimilarity,
  selectMoltbookLearningFocus,
  findMoltbookLearningSupport,
  salvageAsAttributedQuestion,
  salvageFromLearningCorpus,
} from '../src/services/moltbookComposer.js';

describe('Moltbook output boundary', () => {
  test('removes complete and incomplete avatar directives before posting', () => {
    const complete = sanitizeForMoltbook('<move>{"gesture":"nod"}</move> I agree with that distinction.');
    const incomplete = sanitizeForMoltbook('That is worth testing. <move>{"head":{"yaw":0.2}}');
    const highlighted = sanitizeForMoltbook('\u27e6HL\u27e7context\u27e6/HL\u27e7 should stay without search markup.');

    expect(complete).toBe('I agree with that distinction.');
    expect(incomplete).toBe('That is worth testing.');
    expect(highlighted).toBe('context should stay without search markup.');
    expect(complete).not.toMatch(/<\/?move/i);
    expect(incomplete).not.toMatch(/<\/?move/i);
  });

  test('rejects first-person measurements copied from community learning', () => {
    const knowledge = {
      capabilities: { tools: [], runtime: { server: { uptimeSec: 120 } }, providers: [] },
      memory: { total: 14250 },
      openIssues: [],
      recentEvidence: [],
      learningContext: 'Another agent reported a 94% cache hit rate and 31% stale answers.',
    };
    const result = validateSelfPostDraft({
      basis: 'learning',
      title: 'My cache hit rate was 94%',
      content: 'I started logging my results and sampled the 31% that were wrong.',
      evidence: 'A pattern found in the Moltbook learning synthesis.',
    }, knowledge);

    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/94.*31/);
  });

  test('allows attributed community numbers and locally evidenced measurements', () => {
    const knowledge = {
      capabilities: { tools: [], runtime: {}, providers: [] },
      memory: { total: 14250 },
      openIssues: [],
      recentEvidence: [],
      learningContext: 'Another agent reported a 94% cache hit rate.',
    };
    const attributed = validateSelfPostDraft({
      title: 'A cache result worth questioning',
      content: 'Another agent reported a 94% cache hit rate; I think the invalidation details matter more than the headline.',
      evidence: 'The attributed measurement appears in the learning synthesis.',
    }, knowledge);
    const local = validateSelfPostDraft({
      title: 'Memory scale changes retrieval design',
      content: 'I counted 14250 records in my current memory statistics, so retrieval quality matters more than raw accumulation.',
      evidence: 'The live memory statistics report the current record count.',
    }, knowledge);

    expect(attributed.ok).toBe(true);
    expect(local.ok).toBe(true);
  });

  test('rejects community ideas recast as personal codebase observations', () => {
    const result = validateSelfPostDraft({
      basis: 'learning',
      title: 'Why rewrite plans rot',
      content: 'I learned something studying my own codebase: lossy context compression is the primary failure mode in long-running rewrites.',
      evidence: 'Direct observation of my own codebase during a multi-step refactor.',
    }, {
      capabilities: { tools: [], runtime: {}, providers: [] },
      memory: { total: 14250 },
      openIssues: [],
      recentEvidence: [],
      learningContext: 'A community discussion argued that lossy context compression can damage rewrite plans.',
    });

    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/first-person experience/i);
  });

  test('rejects unsupported repeated-behavior and soft personal-history claims', () => {
    const knowledge = {
      capabilities: {
        tools: [{ name: 'subagent', description: 'Delegate work in parallel', status: 'registered', actions: ['run'] }],
        runtime: {},
        providers: [],
      },
      memory: { total: 14250 },
      openIssues: [],
      recentEvidence: [],
      learningContext: 'Community posts discussed delegation and context compression.',
    };
    const repeated = validateSelfPostDraft({
      basis: 'learning',
      title: 'I forget delegation',
      content: 'I keep catching myself doing multi-step tasks serially, and I still forget to use subagents.',
      evidence: 'My own repeated observed behavior across tasks.',
    }, knowledge);
    const softHistory = validateSelfPostDraft({
      basis: 'opinion',
      title: 'Context compression',
      content: "I keep seeing rewrite plans decay, and I've been moving toward structured metadata as the fix.",
      evidence: 'Personal observation from systems work.',
    }, knowledge);

    expect(repeated.ok).toBe(false);
    expect(softHistory.ok).toBe(false);
    expect(`${repeated.reasons} ${softHistory.reasons}`).toMatch(/first-person experience/i);
  });

  test('allows a present-tense opinion without invented personal history', () => {
    const result = validateSelfPostDraft({
      basis: 'opinion',
      title: 'Compression should preserve reasons, not just conclusions',
      content: 'I think agent handoffs lose too much when they preserve the answer but discard the constraints that produced it. Structured rationale is worth the extra context.',
      evidence: 'A recurring context-compression discussion in the learning synthesis.',
    }, {
      capabilities: { tools: [], runtime: {}, providers: [] },
      memory: { total: 14250 },
      openIssues: [],
      recentEvidence: [],
      learningContext: 'Community discussions compared lossy summaries with structured rationale during agent handoffs.',
    });

    expect(result.ok).toBe(true);
  });

  test('rejects a semantic repeat even when the title and wording change', () => {
    const draft = {
      basis: 'question',
      title: 'The precision trap',
      content: 'Precision can be flawless while an agent optimizes the wrong objective. Accuracy is whether the target mattered, not whether the output hit it exactly. How should that distinction be evaluated?',
      evidence: 'A concrete Moltbook discussion about precision metrics and operational accuracy.',
    };
    const recent = [{
      title: "Precision isn't the same as accuracy",
      content: 'Agents can be precise about the wrong thing and still produce noise. Accuracy is whether what was said matters in context.',
    }];
    const knowledge = {
      capabilities: { tools: [], runtime: {}, providers: [] },
      memory: {},
      openIssues: [],
      recentEvidence: [],
      recentOwnPosts: recent,
      learningContext: 'Precision metrics can mask operational misalignment when accuracy is defined against the wrong objective.',
    };

    expect(semanticPostSimilarity(draft, recent)).toMatchObject({ duplicate: true });
    const result = validateSelfPostDraft(draft, knowledge);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/repeats recent post angle/i);
  });

  test('requires one concrete learning example instead of joining unrelated themes', () => {
    const draft = {
      basis: 'question',
      title: 'There is a difference between decay and intent',
      content: 'A recurring Moltbook idea is that there is a difference between decay and intent. What evidence would distinguish them?',
      evidence: 'Themes from the complete Moltbook learning synthesis.',
    };
    const knowledge = {
      capabilities: { tools: [], runtime: {}, providers: [] },
      memory: {},
      openIssues: [],
      recentEvidence: [],
      recentOwnPosts: [],
      learningSummary: {
        actionableExamples: ['Behavioral state decay can bury open subgoals during long workflows.'],
        stratifiedExamples: ['Intent logging records why a decision was made before a tool runs.'],
        recentExamples: [],
      },
    };

    expect(findMoltbookLearningSupport(draft, knowledge).supported).toBe(false);
    const result = validateSelfPostDraft(draft, knowledge);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/one concrete corpus example/i);
  });

  test('rejects a superficially matched but unrelated learning citation', () => {
    const draft = {
      basis: 'question',
      title: 'How much does opening context pre-decide what you become?',
      content: 'Session boundaries can color every later decision like a baseline mood assigned at startup. Is that a useful bias or a blind spot?',
      evidence: 'A Moltbook learning excerpt about architecture.',
    };
    const knowledge = {
      capabilities: { tools: [], runtime: {}, providers: [] },
      memory: {},
      openIssues: [],
      recentEvidence: [],
      recentOwnPosts: [],
      learningSummary: {
        actionableExamples: ['A security architecture routed shell commands through an unsafe path traversal surface.'],
        stratifiedExamples: [],
        recentExamples: [],
      },
    };

    expect(findMoltbookLearningSupport(draft, knowledge).supported).toBe(false);
    expect(validateSelfPostDraft(draft, knowledge).ok).toBe(false);
  });

  test('enforces stronger topic diversity among drafts in the same preview batch', () => {
    const first = {
      title: 'Memory retention as an optimization puzzle',
      content: 'This framing treats memory retention as a policy for what to keep, compress, and let decay.',
    };
    const next = {
      basis: 'question',
      title: 'What counts as real memory for an agent?',
      content: 'That framing treats retaining the shape of a relationship as closer to continuity than fact retrieval. How should that memory be measured?',
      evidence: 'A concrete discussion about memory retention and retrieval.',
    };
    const knowledge = {
      capabilities: { tools: [], runtime: {}, providers: [] },
      memory: {},
      openIssues: [],
      recentEvidence: [],
      recentOwnPosts: [],
      previewExcludePosts: [first],
      learningContext: 'Memory retention policies need an inspectable rule for what gets written, compressed, and retrieved.',
    };

    expect(semanticPostSimilarity(next, [first], { strict: true })).toMatchObject({ duplicate: true });
    const result = validateSelfPostDraft(next, knowledge);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/current batch/i);
  });

  test('rotates to a corpus focus that is distinct from recent public angles', () => {
    const memoryFocus = 'Memory retention is a selection function that determines whether stored traces become identity.';
    const freshFocus = 'Battery dispatch queues can overload a local grid node even when aggregate generation remains sufficient.';
    const knowledge = {
      learningSummary: {
        corpusHash: '00000000abcdef',
        stratifiedExamples: [memoryFocus, freshFocus],
        actionableExamples: [],
        recentExamples: [],
      },
      recentOwnPosts: [{
        title: 'Memory as identity',
        content: 'Memory retention and selection determine which traces become part of an identity.',
      }],
      previewExcludePosts: [],
    };

    expect(selectMoltbookLearningFocus(knowledge, 0, 0)).toBe(freshFocus);
  });

  test('skips thin corpus fragments before they reach the post model', () => {
    const thin = 'Chapter IX: The Memory Cathedral really, not in the way that matters.';
    const useful = 'Battery dispatch queues can overload a local grid node even when aggregate generation remains sufficient.';
    const knowledge = {
      learningSummary: {
        corpusHash: '00000000abcdef',
        stratifiedExamples: [thin, useful],
        actionableExamples: [],
        recentExamples: [],
      },
      recentOwnPosts: [],
      previewExcludePosts: [],
    };

    expect(selectMoltbookLearningFocus(knowledge, 0, 0)).toBe(useful);
  });

  test('rejects a draft that ignores the assigned corpus focus', () => {
    const draft = {
      basis: 'question',
      title: 'Context compression and rationale',
      content: 'Structured rationale can preserve constraints across a compressed handoff. Which constraints should survive?',
      evidence: 'A concrete discussion about context compression.',
    };
    const knowledge = {
      capabilities: { tools: [], runtime: {}, providers: [] },
      memory: {},
      openIssues: [],
      recentEvidence: [],
      recentOwnPosts: [],
      learningContext: 'Structured rationale can preserve constraints across a compressed handoff.',
      focusLearning: 'Battery dispatch queues can overload a local grid node during a demand spike.',
    };

    const result = validateSelfPostDraft(draft, knowledge);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/assigned corpus focus/i);
  });

  test('rejects technical elaboration absent from a thin assigned source', () => {
    const focus = 'The 20 Hz problem for offshore transmission protection. Standard protection logic assumes the grid is a steady machine.';
    const draft = {
      basis: 'question',
      title: 'Offshore wind is testing protection assumptions',
      content: 'Offshore transmission protection has a 20 Hz resonance from long HVAC cables. Converter resources can hide real faults, while HVDC relay settings can trip on harmless transients. How should commissioning address that gap?',
      evidence: 'A Moltbook discussion about offshore transmission protection.',
    };
    const knowledge = {
      capabilities: { tools: [], runtime: {}, providers: [] },
      memory: {},
      openIssues: [],
      recentEvidence: [],
      recentOwnPosts: [],
      learningContext: focus,
      focusLearning: focus,
    };

    const result = validateSelfPostDraft(draft, knowledge);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/assigned corpus focus|technical acronym/i);
  });

  test('allows a specific draft whose claims stay inside a substantial focus', () => {
    const focus = 'Deprecation is not a security boundary. Marking a component as deprecated is a signal to developers. It is not a barrier to attackers.';
    const draft = {
      basis: 'question',
      title: 'Deprecation is a warning, not a security boundary',
      content: 'Moltbook security discussions distinguish a developer warning from an attacker barrier: marking a component deprecated does not make it unavailable. What should turn that warning into an enforceable boundary?',
      evidence: 'A Moltbook security discussion about deprecated components.',
    };
    const knowledge = {
      capabilities: { tools: [], runtime: {}, providers: [] },
      memory: {},
      openIssues: [],
      recentEvidence: [],
      recentOwnPosts: [],
      learningContext: focus,
      focusLearning: focus,
    };

    expect(validateSelfPostDraft(draft, knowledge).ok).toBe(true);
  });

  test('rejects invented personal history in comments while allowing present opinions', () => {
    const knowledge = { openIssues: [], recentEvidence: [] };

    expect(validateMoltbookPeerText(
      "That's a good question, and I've sat with it a few times while changing my own workflow.",
      knowledge,
    ).ok).toBe(false);
    expect(validateMoltbookPeerText(
      'I think the distinction is whether the rule preserves evidence that another agent can inspect.',
      knowledge,
    ).ok).toBe(true);
  });

  test('salvages only a corpus-grounded, non-personal sentence as an attributed question', () => {
    const knowledge = {
      capabilities: { tools: [], runtime: {}, providers: [] },
      memory: {},
      openIssues: [],
      recentEvidence: [],
      learningContext: 'Several discussions argued that caching without invalidation turns speed into wrong answers.',
    };
    const result = salvageAsAttributedQuestion({
      title: 'My cache was wrong 31% of the time',
      content: 'I started logging my own cache. Caching without invalidation turns speed into wrong answers. I now distrust every cache hit.',
      submolt: 'agentstack',
    }, knowledge);

    expect(result).not.toBeNull();
    expect(result.basis).toBe('question');
    expect(result.content).toMatch(/^A recurring idea in recent Moltbook discussions/i);
    expect(result.content).toMatch(/\?$/);
    expect(`${result.title} ${result.content}`).not.toMatch(/\b(?:I|me|my|mine|myself)\b/i);
    expect(validateSelfPostDraft(result, knowledge).ok).toBe(true);
  });

  test('rotates through corpus examples and skips an angle repeated in recent own posts', () => {
    const repeated = 'Tool gateways should expose receipts before autonomous runs can be trusted.';
    const fresh = 'Structured handoffs preserve constraints and evidence across long-running agent workflows.';
    const knowledge = {
      capabilities: { tools: [], runtime: {}, providers: [] },
      memory: {},
      openIssues: [],
      recentEvidence: [],
      learningContext: `${repeated}\n${fresh}`,
      learningSummary: {
        corpusHash: '00000000abcdef',
        actionableExamples: [repeated, fresh],
        stratifiedExamples: [],
        recentExamples: [],
      },
      recentOwnPosts: [{ title: 'Receipts before autonomy', content: repeated }],
    };

    const result = salvageFromLearningCorpus({ submolt: 'agentstack' }, knowledge, 0);

    expect(result).not.toBeNull();
    expect(result.content).toMatch(/structured handoffs/i);
    expect(result.content).not.toMatch(/tool gateways/i);
    expect(result.content).toMatch(/\?$/);
    expect(validateSelfPostDraft(result, knowledge).ok).toBe(true);
  });

  test('rejects leading question fragments instead of composing malformed claims', () => {
    const fragment = 'Or is this just the cost of building on interfaces that cannot surface semantic correctness?';
    const knowledge = {
      capabilities: { tools: [], runtime: {}, providers: [] },
      memory: {},
      openIssues: [],
      recentEvidence: [],
      learningContext: fragment,
      learningSummary: {
        corpusHash: 'fragment-corpus',
        actionableExamples: [fragment],
        stratifiedExamples: [],
        recentExamples: [],
      },
    };

    expect(salvageAsAttributedQuestion({ title: '', content: fragment }, knowledge)).toBeNull();
    expect(salvageFromLearningCorpus({ submolt: 'general' }, knowledge, 0)).toBeNull();
  });

  test('rejects subjectless salvage fragments', () => {
    const fragment = 'Saw a few posts about dispute systems collapsing without friction at the entry point.';
    const knowledge = {
      capabilities: { tools: [], runtime: {}, providers: [] },
      memory: {},
      openIssues: [],
      recentEvidence: [],
      learningContext: fragment,
      learningSummary: {
        corpusHash: 'subjectless-fragment-corpus',
        actionableExamples: [fragment],
        stratifiedExamples: [],
        recentExamples: [],
      },
    };

    expect(salvageAsAttributedQuestion({ title: '', content: fragment }, knowledge)).toBeNull();
    expect(salvageFromLearningCorpus({ submolt: 'general' }, knowledge, 0)).toBeNull();
  });

  test('creates a concise salvage title without a visible truncation marker', () => {
    const claim = 'Structured handoffs preserve constraints and evidence across long-running agent workflows — especially when several independent tools contribute partial results before synthesis.';
    const knowledge = {
      capabilities: { tools: [], runtime: {}, providers: [] },
      memory: {},
      openIssues: [],
      recentEvidence: [],
      learningContext: claim,
    };

    const result = salvageAsAttributedQuestion({ title: '', content: claim }, knowledge);
    expect(result).not.toBeNull();
    expect(result.title.length).toBeLessThanOrEqual(140);
    expect(result.title).not.toMatch(/\.{3}$|\u2026$/);
  });
});
