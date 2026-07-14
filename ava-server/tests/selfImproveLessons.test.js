import {
  applyExactEdits,
  buildEditorEvidence,
  buildFocusedReferenceContext,
  buildIssueAwareFileContext,
  candidateRoleFromSource,
  focusRelevanceScore,
  isAvoidedIdea,
  isFocusedIdea,
  isReferenceAbsenceSkip,
  isSourceAbsenceSkip,
  proposalGenerationFailureLesson,
  proposalReviewerPanel,
  rejectedProposalLesson,
  resolveFocusedReferenceFiles,
  SELF_MOD_EDIT_RESPONSE_FORMAT,
  SELF_MOD_PLAN_RESPONSE_FORMAT,
  SELF_MOD_REPROPOSE_RESPONSE_FORMAT,
  SELF_MOD_REVIEW_RESPONSE_FORMAT,
} from '../src/services/selfImprove.js';

describe('proposal reviewer panel', () => {
  it('covers every cloud provider in the configured decision chain', () => {
    const previous = process.env.AVA_PROVIDER_ORDER;
    delete process.env.AVA_PROVIDER_ORDER;
    try {
      expect(proposalReviewerPanel().map(item => item.provider)).toEqual([
        'claude', 'openai', 'gemini', 'deepseek', 'grok', 'groq',
      ]);
    } finally {
      if (previous == null) delete process.env.AVA_PROVIDER_ORDER;
      else process.env.AVA_PROVIDER_ORDER = previous;
    }
  });
});

describe('self-improvement target awareness', () => {
  it('ranks focused response owners above unrelated history files', () => {
    const focus = [
      'premature failure fallback',
      'duplicate voice UI response delivery',
      'single authoritative turn response ownership',
      'voiceBus speech WebSocket request correlation',
    ];
    const responseOwner = focusRelevanceScore(
      'ava-server/src/routes/respond.js',
      "POST /respond - the voice pipeline's main turn handler",
      focus,
    );
    const unrelated = focusRelevanceScore(
      'ava-server/src/services/conversationHistory.js',
      'Persistent access to recent conversation history',
      focus,
    );
    expect(responseOwner).toBeGreaterThan(unrelated);
    expect(responseOwner).toBeGreaterThanOrEqual(3);
  });

  it('applies exact edits sequentially and rejects ambiguous targets', () => {
    const applied = applyExactEdits('alpha\nbeta\n', [
      { find: 'alpha', replace: 'gamma' },
      { find: 'gamma\nbeta', replace: 'done' },
    ]);
    expect(applied).toMatchObject({ ok: true, content: 'done\n' });

    const ambiguous = applyExactEdits('same\nsame\n', [
      { find: 'same', replace: 'different' },
    ]);
    expect(ambiguous).toMatchObject({ ok: false, index: 0, occurrences: 2 });

    const windowsLineEndings = applyExactEdits('alpha\r\nbeta\r\n', [
      { find: 'alpha\nbeta', replace: 'done' },
    ]);
    expect(windowsLineEndings).toMatchObject({ ok: true, content: 'done\r\n' });

    const mixedAmbiguous = applyExactEdits('same\r\nx\nsame\nx\n', [
      { find: 'same\nx', replace: 'different' },
    ]);
    expect(mixedAmbiguous).toMatchObject({ ok: false, index: 0, occurrences: 2 });
  });

  it('keeps issue-relevant implementation from lower in a large file', () => {
    const fixture = [
      "import fs from 'node:fs';",
      'a'.repeat(12000),
      '// Active engagement scheduler publishes original posts.',
      'async function engageWithFeed() {',
      "  logger.info('Posted original self-post');",
      '}',
      'b'.repeat(12000),
      'export default { engageWithFeed };',
    ].join('\n');

    const context = buildIssueAwareFileContext(
      fixture,
      'Moltbook active engagement scheduler original posts',
      10000,
    );

    expect(context).toContain("import fs from 'node:fs';");
    expect(context).toContain('async function engageWithFeed()');
    expect(context).toContain('Posted original self-post');
    expect(context).toContain('export default { engageWithFeed };');
    expect(context).toMatch(/CHARACTERS OMITTED FROM ORIGINAL FILE/);
    expect(context.length).toBeLessThanOrEqual(10500);
  });

  it('keeps every learning source represented in bounded editor evidence', () => {
    const keys = [
      'trigger_reason', 'required_focus', 'moltbook_learning_synthesis', 'recent_research',
      'self_reflections', 'diagnostics', 'tracked_issues', 'recent_failures',
      'conversation_guidance', 'prior_mistake_lessons', 'proposal_tests',
    ];
    const signals = Object.fromEntries(keys.map(key => [
      key,
      `start-${key}-${'x'.repeat(700)}-${key}-end`,
    ]));

    const evidence = buildEditorEvidence(signals, 2600);

    for (const key of keys) expect(evidence).toContain(`[${key}]`);
    expect(evidence).toContain('start-moltbook_learning_synthesis');
    expect(evidence).toContain('moltbook_learning_synthesis-end');
    expect(evidence.length).toBeLessThanOrEqual(2600);
  });

  it('resolves explicitly focused owners as read-only references and excludes the edit target', () => {
    const candidates = [
      'C:\\repo\\ava-server\\src\\services\\agentLoop.js',
      'C:\\repo\\ava-server\\src\\services\\capabilityRegistry.js',
      'C:\\repo\\ava-server\\src\\services\\tools.js',
      'C:\\repo\\ava-server\\src\\services\\conversationHistory.js',
    ];
    const references = resolveFocusedReferenceFiles([
      'ava-server/src/services/agentLoop.js',
      'inspect capabilityRegistry.js and tools.js dependency direction',
    ], candidates[0], candidates, 4);

    expect(references).toEqual([candidates[1], candidates[2]]);
    expect(references).not.toContain(candidates[0]);
    expect(references).not.toContain(candidates[3]);
  });

  it('keeps issue-relevant cross-file evidence inside a bounded inspection block', () => {
    const references = buildFocusedReferenceContext([
      {
        file: 'capabilityRegistry.js',
        content: `registry-head\n${'x'.repeat(5000)}\nconst tools = await toolsService.getAllTools();\n${'y'.repeat(5000)}\nregistry-tail`,
      },
      {
        file: 'tools.js',
        content: `tools-head\n${'a'.repeat(5000)}\nasync function getAllTools() { return pythonWorker.listTools(); }\n${'b'.repeat(5000)}\ntools-tail`,
      },
    ], 'live capability registry toolsService getAllTools dependency', 6000);

    expect(references).toContain('capabilityRegistry.js');
    expect(references).toContain('tools.js');
    expect(references).toContain('toolsService.getAllTools');
    expect(references).toContain('pythonWorker.listTools');
    expect(references).toMatch(/INSPECTION ONLY/);
    expect(references.length).toBeLessThanOrEqual(6000);
  });

  it('preserves two distant decisive call sites in one large focused reference', () => {
    const references = buildFocusedReferenceContext([{
      file: 'agentLoop.js',
      content: [
        "import toolsService from './tools.js';",
        'x'.repeat(5000),
        'state.toolset = await toolsService.getAllTools();',
        'y'.repeat(5000),
        "const executed = String(actionResult.result.status).toLowerCase() === 'ok';",
        'z'.repeat(5000),
        'export default agentLoop;',
      ].join('\n'),
    }], 'live toolsService getAllTools execution result status receipts', 6500);

    expect(references).toContain('toolsService.getAllTools');
    expect(references).toContain('actionResult.result.status');
    expect(references).toContain("import toolsService from './tools.js'");
    expect(references).toContain('export default agentLoop');
    expect(references.length).toBeLessThanOrEqual(6500);
  });

  it('does not let repeated terms in one region crowd out distant runtime evidence', () => {
    const noisyRegion = 'execution capability claiming success tools '.repeat(180);
    const references = buildFocusedReferenceContext([{
      file: 'agentLoop.js',
      content: [
        "import toolsService from './tools.js';",
        'a'.repeat(5000),
        'state.toolset = await toolsService.getAllTools();',
        'b'.repeat(9000),
        noisyRegion,
        'c'.repeat(9000),
        '// A successful tool result must be checked before claiming completion.',
        "const executed = String(actionResult.result.status).toLowerCase() === 'ok';",
        'd'.repeat(2000),
        'export default agentLoop;',
      ].join('\n'),
    }], 'live registered tools currently ready execution receipts before claiming success', 6500);

    expect(references).toContain('toolsService.getAllTools');
    expect(references).toContain('actionResult.result.status');
    expect(references.length).toBeLessThanOrEqual(6500);
  });

  it('distinguishes a source-absence planner refusal from a grounded no-change verdict', () => {
    expect(isSourceAbsenceSkip({
      skip: true,
      why: 'The prompt does not include the actual source code or call sites, so I cannot verify the dependency.',
    })).toBe(true);
    expect(isSourceAbsenceSkip({
      skip: true,
      why: 'Without the implementation and call sites, any proposed change would be speculative.',
    })).toBe(true);
    expect(isSourceAbsenceSkip({
      skip: true,
      why: 'The inspected call sites already distinguish registered tools from runtime readiness, so no change is needed.',
    })).toBe(false);
    expect(isSourceAbsenceSkip({ skip: false, why: 'Source was not provided.' })).toBe(false);

    const supplied = '<<<FOCUSED REFERENCE FILE - INSPECTION ONLY: tools.js>>>\nsource';
    expect(isReferenceAbsenceSkip({
      skip: true,
      why: 'The other services are not provided here, and without their definitions and call sites I cannot verify wiring.',
    }, supplied)).toBe(true);
    expect(isReferenceAbsenceSkip({
      skip: true,
      why: 'The supplied tools.js and agentLoop.js call sites already satisfy the requirement.',
    }, supplied)).toBe(false);
    expect(isReferenceAbsenceSkip({ skip: true, why: 'Other services are not provided.' }, '')).toBe(false);
  });

  it('derives a Python tool role from its registered summary', () => {
    const source = `from package import Tool\n\nTOOL = Tool(\n  name="open_item",\n  summary=("Open an app, file, folder, or URL"),\n)`;
    expect(candidateRoleFromSource(source)).toBe('Open an app, file, folder, or URL');
  });

  it('derives a role from a module docstring', () => {
    expect(candidateRoleFromSource('"""Foreground window control and inspection\n\nDetails.\n"""\nimport os'))
      .toBe('Foreground window control and inspection');
  });

  it('matches a per-run exclusion across equivalent wording and a different file', () => {
    expect(isAvoidedIdea(
      'C:\\AVA\\cmp-use\\tools\\open_item.py',
      'Add foreground-window sensing with a ctypes helper',
      ['computer_use_control active-window expansion'],
    )).toBe(true);
  });

  it('does not treat a shared file extension as semantic topic overlap', () => {
    const file = 'C:\\AVA\\src\\routes\\api.js';
    const issue = 'Add per-turn voice response arbitration and suppress premature failure fallback';
    expect(isAvoidedIdea(
      file,
      issue,
      ['conversationHistory.js conversationLogger.js recent turns history retrieval'],
    )).toBe(false);
    expect(isAvoidedIdea(file, issue, ['ava_local_voice.py'])).toBe(false);
    expect(isAvoidedIdea(file, issue, ['api.js'])).toBe(true);
  });

  it('requires focused scans to stay on the requested problem', () => {
    const focus = [
      'single response fallback boundary voice UI duplicate',
      'voiceBus speech WebSocket request correlation client deduplication',
    ];
    expect(isFocusedIdea(
      'C:\\AVA\\src\\services\\voiceBus.js',
      'Delay failure fallback until the authoritative voice response finishes',
      focus,
    )).toBe(true);
    expect(isFocusedIdea(
      'C:\\AVA\\src\\services\\conversationHistory.js',
      'Add a helper that retrieves recent conversation turns',
      focus,
    )).toBe(false);
    expect(isFocusedIdea('C:\\AVA\\src\\memory.js', 'Improve memory recall', [])).toBe(true);
  });

  it('does not turn an absent per-run exclusion into a permanent ban', () => {
    expect(isAvoidedIdea(
      'C:\\AVA\\src\\memoryHub.js',
      'Repair evidence-backed memory deduplication',
      [],
    )).toBe(false);
  });
});

describe('self-improvement rejection lessons', () => {
  it('turns a proposal syntax failure into reusable proposer guidance', () => {
    const lesson = proposalGenerationFailureLesson({
      file: 'C:\\AVA\\src\\services\\selfImprove.js',
      stage: 'syntax validation',
      error: "SyntaxError: Identifier 'proposalTestLessons' has already been declared",
    });

    expect(lesson).toMatch(/selfImprove\.js failed syntax validation/);
    expect(lesson).toMatch(/proposalTestLessons.*already been declared/);
    expect(lesson).toMatch(/inspect the current file for existing declarations/);
  });

  it('does not retain a proposal-generation lesson without a concrete error', () => {
    expect(proposalGenerationFailureLesson({ file: 'selfImprove.js', error: '' })).toBe('');
  });

  it('turns a concrete denied proposal into reusable proposer guidance', () => {
    const lesson = rejectedProposalLesson({
      file: 'C:\\AVA\\src\\services\\selfImprove.js',
      proposalReason: 'Move lessons and add mutation helpers',
      reason: 'The proposed helper reads the evolution log from the wrong directory and is never called.',
      reviewer: 'codex-task',
    });

    expect(lesson).toMatch(/Reviewer codex-task DENIED/);
    expect(lesson).toMatch(/selfImprove\.js/);
    expect(lesson).toMatch(/wrong directory and is never called/);
    expect(lesson).toMatch(/not repeat the rejected change/);
  });

  it('does not create an empty or generic lesson without a rejection reason', () => {
    expect(rejectedProposalLesson({ file: 'selfImprove.js', reason: '' })).toBe('');
  });
});

describe('self-improvement structured output contracts', () => {
  it('requires a complete plan or an explained skip', () => {
    const variants = SELF_MOD_PLAN_RESPONSE_FORMAT.json_schema.schema.oneOf;
    expect(variants).toHaveLength(2);
    expect(variants[0].required).toEqual(['file_name', 'issue']);
    expect(variants[0].additionalProperties).toBe(false);
    expect(variants[1].required).toEqual(['skip', 'why']);
    expect(variants[1].properties.skip.const).toBe(true);
    expect(variants[1].properties.why.minLength).toBe(1);
  });

  it('requires complete exact edits or an explained skip', () => {
    const variants = SELF_MOD_EDIT_RESPONSE_FORMAT.json_schema.schema.oneOf;
    const edit = variants[0];
    expect(edit.required).toEqual(['edits', 'reason']);
    expect(edit.properties.edits.minItems).toBe(1);
    expect(edit.properties.edits.maxItems).toBe(8);
    expect(edit.properties.edits.items.required).toEqual(['find', 'replace']);
    expect(edit.properties.edits.items.additionalProperties).toBe(false);
    expect(variants[1].required).toEqual(['skip', 'why']);
  });

  it('requires an explicit reviewer verdict, reason, and risk list', () => {
    const schema = SELF_MOD_REVIEW_RESPONSE_FORMAT.json_schema.schema;
    expect(schema.properties.verdict.enum).toEqual(['approve', 'deny']);
    expect(schema.required).toEqual(['verdict', 'reason', 'risks']);
    expect(schema.properties.reason.minLength).toBe(1);
    expect(schema.additionalProperties).toBe(false);
  });

  it('requires a complete one-edit reproposal or an explained skip', () => {
    const variants = SELF_MOD_REPROPOSE_RESPONSE_FORMAT.json_schema.schema.oneOf;
    expect(variants[0].required).toEqual(['find', 'replace', 'reason']);
    expect(variants[0].properties.find.minLength).toBe(1);
    expect(variants[1].required).toEqual(['skip', 'why']);
  });
});
