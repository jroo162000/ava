import { canonicalModels, proposalReviewerModels, providerOrder } from '../src/utils/modelConfig.js';

const TEST_ENV_NAMES = [
  'AVA_SM_CLAUDE', 'AVA_CLAUDE_MODEL', 'AVA_PROVIDER_ORDER',
  'AVA_REVIEW_CLAUDE', 'AVA_REVIEW_OPENAI', 'AVA_REVIEW_GEMINI',
  'AVA_REVIEW_DEEPSEEK', 'AVA_REVIEW_GROK', 'AVA_REVIEW_GROQ',
];
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

describe('proposal reviewer models', () => {
  test('tries the strongest current cloud model first for every provider', () => {
    for (const name of TEST_ENV_NAMES.filter(name => name.startsWith('AVA_REVIEW_'))) delete process.env[name];
    const models = proposalReviewerModels();

    expect(models.claude[0]).toBe('claude-fable-5');
    expect(models.openai[0]).toBe('gpt-5.6-sol');
    expect(models.gemini[0]).toBe('gemini-3.1-pro-preview');
    expect(models.deepseek[0]).toBe('deepseek-v4-pro');
    expect(models.grok[0]).toBe('grok-4.5');
    expect(models.groq[0]).toBe('openai/gpt-oss-120b');
  });

  test('keeps explicit reviewer overrides authoritative and ordered', () => {
    process.env.AVA_REVIEW_OPENAI = 'account-frontier,account-fallback';
    expect(proposalReviewerModels().openai).toEqual(['account-frontier', 'account-fallback']);
  });
});
