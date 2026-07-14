import { canonicalModels } from '../src/utils/modelConfig.js';

const CLAUDE_ENV_NAMES = ['AVA_SM_CLAUDE', 'AVA_CLAUDE_MODEL'];
const originalClaudeEnv = Object.fromEntries(CLAUDE_ENV_NAMES.map(name => [name, process.env[name]]));

afterEach(() => {
  for (const name of CLAUDE_ENV_NAMES) {
    const original = originalClaudeEnv[name];
    if (original == null) delete process.env[name];
    else process.env[name] = original;
  }
});

describe('canonical Claude model configuration', () => {
  test('uses the verified Haiku fallback when no override is configured', () => {
    for (const name of CLAUDE_ENV_NAMES) delete process.env[name];

    expect(canonicalModels().claude).toBe('claude-haiku-4-5-20251001');
  });

  test('keeps environment configuration authoritative', () => {
    process.env.AVA_SM_CLAUDE = 'claude-sonnet-5';
    process.env.AVA_CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

    expect(canonicalModels().claude).toBe('claude-sonnet-5');
  });
});
