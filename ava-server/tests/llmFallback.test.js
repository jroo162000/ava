import { jest } from '@jest/globals';
import llmService from '../src/services/llm.js';

const ENV_KEYS = [
  'AVA_PROVIDER_ORDER',
  'AVA_PROVIDER_COOLDOWN_MS',
  'AVA_LOCAL_LLM_MODEL',
];

describe('cloud-primary completion routing', () => {
  const originalEnv = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    process.env.AVA_PROVIDER_ORDER = 'openai,local';
    process.env.AVA_PROVIDER_COOLDOWN_MS = '1';
    process.env.AVA_LOCAL_LLM_MODEL = 'test-local-model';
    jest.spyOn(llmService, 'getApiKey').mockImplementation(provider => (
      provider === 'openai' || provider === 'local' ? 'configured' : null
    ));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  test('uses the cloud provider without touching the local queue while credits work', async () => {
    jest.spyOn(llmService, 'createCompletionOpenAI').mockResolvedValue({
      content: 'cloud answer',
      provider: 'openai',
      model: 'test-cloud-model',
    });
    const queueRun = jest.spyOn(llmService.localQueue, 'run');

    const result = await llmService.createCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      requireText: true,
    });

    expect(result.provider).toBe('openai');
    expect(result.content).toBe('cloud answer');
    expect(queueRun).not.toHaveBeenCalled();
  });

  test('hands off to LocalLlmQueue only after cloud credit exhaustion', async () => {
    jest.spyOn(llmService, 'createCompletionOpenAI').mockRejectedValue(
      new Error('429 insufficient_quota: API credits exhausted'),
    );
    jest.spyOn(llmService, '_streamOpenAICompat').mockResolvedValue({
      content: 'local fallback answer',
      model: 'test-local-model',
    });
    const queueRun = jest.spyOn(llmService.localQueue, 'run')
      .mockImplementation(async (task, options) => {
        expect(options.priority).toBe('interactive');
        return task(new AbortController().signal);
      });

    const result = await llmService.createCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      requireText: true,
      localPriority: 'interactive',
    });

    expect(llmService.createCompletionOpenAI).toHaveBeenCalled();
    expect(queueRun).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe('local');
    expect(result.content).toBe('local fallback answer');
  });
});
