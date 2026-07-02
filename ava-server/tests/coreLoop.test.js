// Core-loop golden-path tests (Tier 1 #9)
// Covers the previously-untested heart of the agent: decision parsing (legacy JSON path),
// native tool-call mapping (Tier 1 #4), scope-limiting (multi-step detection), role tool-
// scoping, and context budgeting (Tier 1 #7).

import agentLoop from '../src/services/agentLoop.js';
import contextBudget from '../src/utils/contextBudget.js';

const { parseDecisionJson, isMultiStepGoal, mapNativeDecision, buildNativeTools, _toolAllowed } = agentLoop._internals;
const { DecisionType } = agentLoop;

describe('decision parsing (legacy JSON path)', () => {
  it('parses a clean tool_call decision', () => {
    const d = parseDecisionJson('{"decision":"tool_call","tool":"fs_read","args":{"path":"a.txt"}}');
    expect(d.decision).toBe('tool_call');
    expect(d.tool).toBe('fs_read');
    expect(d.args.path).toBe('a.txt');
  });

  it('parses JSON wrapped in a markdown fence with prose around it', () => {
    const d = parseDecisionJson('Sure thing.\n```json\n{"decision":"stop","result":"done","success":true}\n```\nHope that helps!');
    expect(d.decision).toBe('stop');
    expect(d.success).toBe(true);
  });

  it('repairs JSON truncated mid-string (token-limit cutoff)', () => {
    const d = parseDecisionJson('{"decision":"tool_call","tool":"web_search","args":{"query":"weather"},"reasoning":"the user asked about the fore');
    expect(d.decision).toBe('tool_call');
    expect(d.tool).toBe('web_search');
    expect(d.args.query).toBe('weather');
  });

  it('repairs invalid Windows-path backslashes', () => {
    const d = parseDecisionJson('{"decision":"tool_call","tool":"fs_read","args":{"path":"C:\\Users\\me\\a.txt"}}');
    expect(d.tool).toBe('fs_read');
    expect(d.args.path).toContain('Users');
  });
});

describe('scope-limiting (multi-step goal detection)', () => {
  it('treats a single action as single-step', () => {
    expect(isMultiStepGoal('take a screenshot')).toBe(false);
  });
  it('detects chained actions', () => {
    expect(isMultiStepGoal('take a screenshot and then open it')).toBe(true);
  });
  it('detects two distinct action verbs', () => {
    expect(isMultiStepGoal('find my resume and send it to Bob')).toBe(true);
  });
});

describe('native tool-call mapping (Tier 1 #4)', () => {
  const lead = { canDelegate: true, toolset: [] };
  const sub = { canDelegate: false, toolset: [] };

  it('maps a single tool call', () => {
    const d = mapNativeDecision(lead, { toolCalls: [{ name: 'fs_read', args: { path: 'a.txt' } }], text: '' });
    expect(d.decision).toBe(DecisionType.TOOL_CALL);
    expect(d.tool).toBe('fs_read');
    expect(d.args.path).toBe('a.txt');
  });

  it('maps multiple tool calls to a parallel fan-out', () => {
    const d = mapNativeDecision(lead, { toolCalls: [
      { name: 'memory_search', args: { query: 'x' } },
      { name: 'fs_find', args: { pattern: 'y' } }
    ], text: '' });
    expect(d.decision).toBe(DecisionType.PARALLEL);
    expect(d.tool_calls).toHaveLength(2);
  });

  it('maps ask_user to a clarifying question', () => {
    const d = mapNativeDecision(lead, { toolCalls: [{ name: 'ask_user', args: { question: 'Which file?' } }], text: '' });
    expect(d.decision).toBe(DecisionType.ASK_USER);
    expect(d.question).toBe('Which file?');
  });

  it('maps delegate for the lead agent', () => {
    const d = mapNativeDecision(lead, { toolCalls: [{ name: 'delegate', args: { subtasks: [{ role: 'general', goal: 'research x' }] } }], text: '' });
    expect(d.decision).toBe(DecisionType.DELEGATE);
    expect(d.subtasks).toHaveLength(1);
  });

  it('does NOT delegate for subagents (no recursion)', () => {
    const d = mapNativeDecision(sub, { toolCalls: [{ name: 'delegate', args: { subtasks: [{ goal: 'x' }] } }], text: '' });
    expect(d === null || d.decision !== DecisionType.DELEGATE).toBe(true);
  });

  it('maps plain text to STOP (final answer)', () => {
    const d = mapNativeDecision(lead, { toolCalls: [], text: 'Paris is the capital of France.' });
    expect(d.decision).toBe(DecisionType.STOP);
    expect(d.result).toContain('Paris');
    expect(d.success).toBe(true);
  });

  it('returns null on an empty response (caller falls back to JSON path)', () => {
    expect(mapNativeDecision(lead, { toolCalls: [], text: '' })).toBeNull();
  });
});

describe('native toolset construction', () => {
  const state = {
    canDelegate: true,
    toolset: [
      { name: 'comm_ops', description: 'email', schema: { type: 'object', properties: { action: { type: 'string', enum: ['read_emails', 'send'] } } }, requires_confirm: true, risk_level: 'high' },
      { name: 'no_schema_tool', description: 'plain' }
    ]
  };

  it('passes full schemas through and appends control tools', () => {
    const tools = buildNativeTools(state);
    const names = tools.map(t => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['comm_ops', 'no_schema_tool', 'ask_user', 'delegate']));
    const comm = tools.find(t => t.function.name === 'comm_ops');
    expect(comm.function.parameters.properties.action.enum).toContain('read_emails');
    expect(comm.function.description).toContain('confirmed:true');
    expect(comm.function.description).toContain('HIGH RISK');
    const plain = tools.find(t => t.function.name === 'no_schema_tool');
    expect(plain.function.parameters.type).toBe('object');
  });

  it('omits delegate for subagents', () => {
    const tools = buildNativeTools({ ...state, canDelegate: false });
    expect(tools.map(t => t.function.name)).not.toContain('delegate');
  });
});

describe('subagent role tool-scoping', () => {
  it('allows everything for an unscoped agent', () => {
    expect(_toolAllowed({}, 'anything')).toBe(true);
  });
  it('enforces the allowlist with wildcards', () => {
    const state = { allowedTools: ['fs_*', 'memory_search'] };
    expect(_toolAllowed(state, 'fs_read')).toBe(true);
    expect(_toolAllowed(state, 'memory_search')).toBe(true);
    expect(_toolAllowed(state, 'comm_ops')).toBe(false);
  });
  it('enforces the denylist over the allowlist', () => {
    const state = { allowedTools: ['*'], deniedTools: ['ps_exec'] };
    expect(_toolAllowed(state, 'fs_read')).toBe(true);
    expect(_toolAllowed(state, 'ps_exec')).toBe(false);
  });
});

describe('context budgeting (Tier 1 #7)', () => {
  it('passes small payloads through untouched', () => {
    const r = contextBudget.fit({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], completionTokens: 100 });
    expect(r.trimmed).toBe(false);
    expect(r.messages[0].content).toBe('hi');
  });

  it('trims oversized history but keeps the system prompt and last user message', () => {
    const big = 'x'.repeat(40000); // ~10k tokens each
    const messages = [
      { role: 'user', content: big },
      { role: 'assistant', content: big },
      { role: 'user', content: big },
      { role: 'assistant', content: big },
      { role: 'user', content: 'what is the weather today?' }
    ];
    const r = contextBudget.fit({ system: 'You are AVA.', messages, completionTokens: 1000, budgetTokens: 8000 });
    expect(r.trimmed).toBe(true);
    expect(r.tokens).toBeLessThanOrEqual(8000);
    expect(r.system).toBe('You are AVA.');
    const lastUser = r.messages.filter(m => m.role === 'user').pop();
    expect(lastUser.content).toContain('weather');
  });

  it('middle-truncates a single oversized message instead of dropping it', () => {
    const r = contextBudget.fit({
      system: 's',
      messages: [{ role: 'user', content: 'HEAD ' + 'y'.repeat(200000) + ' TAIL' }],
      completionTokens: 500,
      budgetTokens: 5000
    });
    expect(r.trimmed).toBe(true);
    const c = r.messages[0].content;
    expect(c).toContain('HEAD');
    expect(c).toContain('TAIL');
    expect(c).toContain('trimmed');
  });
});
