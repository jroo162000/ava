import { canonicalModels, providerOrder } from '../src/utils/modelConfig.js';

const TEST_ENV_NAMES = ['AVA_SM_CLAUDE', 'AVA_CLAUDE_MODEL', 'AVA_PROVIDER_ORDER'];
const originalEnv = Object.fromEntries(TEST_ENV_NAMES.map(name => [name, process.env[name]]));

afterEach(() => {
  for (const name of TEST_ENV_NAMES) {
    const original = originalEnv[name];
    if (original == null) delete process.env[name];
    else process.env[name] = original;
  }
});

describe('canonical Claude model configuration', () => {
  test('uses the verified Haiku fallback when no override is configured', () => {
    for (const name of ['AVA_SM_CLAUDE', 'AVA_CLAUDE_MODEL']) delete process.env[name];

    expect(canonicalModels().claude).toBe('claude-haiku-4-5-20251001');
  });

  test('keeps environment configuration authoritative', () => {
    process.env.AVA_SM_CLAUDE = 'claude-sonnet-5';
    process.env.AVA_CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

    expect(canonicalModels().claude).toBe('claude-sonnet-5');
  });
});

describe('provider order', () => {
  test('always keeps the local model behind every requested cloud provider', () => {
    process.env.AVA_PROVIDER_ORDER = 'local,openai,claude,local';

    expect(providerOrder()).toEqual(['openai', 'claude', 'local']);
  });

  test('includes local as the final fallback when an override omits it', () => {
    process.env.AVA_PROVIDER_ORDER = 'gemini,deepseek';

    expect(providerOrder()).toEqual(['gemini', 'deepseek', 'local']);
  });
});
