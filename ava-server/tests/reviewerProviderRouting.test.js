import { jest } from '@jest/globals';
import llmService from '../src/services/llm.js';

const responseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'review',
    schema: { type: 'object', properties: { verdict: { type: 'string' } } },
  },
};

describe('direct proposal reviewer provider routing', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.spyOn(llmService, 'getApiKey').mockReturnValue('test-key');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('sends GPT-5.6 Sol directly with high reasoning and structured output', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ model: 'gpt-5.6-sol', choices: [{ message: { content: '{"verdict":"approve"}' } }] }),
    }));

    await llmService.createCompletionForProvider('openai', {
      model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'review' }],
      system: 'reviewer', maxTokens: 700, responseFormat,
    });

    const [url, options] = global.fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(body).toMatchObject({ model: 'gpt-5.6-sol', reasoning_effort: 'high', response_format: responseFormat });
  });

  test('treats Claude Fable 5 as a current model that must not receive temperature', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ model: 'claude-fable-5', content: [{ type: 'text', text: '{"verdict":"approve"}' }] }),
    }));

    await llmService.createCompletionForProvider('claude', {
      model: 'claude-fable-5', messages: [{ role: 'user', content: 'review' }], system: 'reviewer', maxTokens: 700,
    });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.model).toBe('claude-fable-5');
    expect(body).not.toHaveProperty('temperature');
  });

  test('passes the selected Groq model instead of silently using the chat default', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ model: 'openai/gpt-oss-120b', choices: [{ message: { content: '{"verdict":"approve"}' } }] }),
    }));

    await llmService.createCompletionForProvider('groq', {
      model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'review' }],
      system: 'reviewer', maxTokens: 700, responseFormat,
    });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.model).toBe('openai/gpt-oss-120b');
    expect(body.response_format).toEqual(responseFormat);
  });

  test('routes DeepSeek through its own endpoint without falling through the main chain', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ model: 'deepseek-v4-pro', choices: [{ message: { content: '{"verdict":"approve"}' } }] }),
    }));

    const result = await llmService.createCompletionForProvider('deepseek', {
      model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'review' }],
      system: 'reviewer', maxTokens: 700, responseFormat,
    });

    expect(global.fetch.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions');
    expect(result.provider).toBe('deepseek');
    expect(result.model).toBe('deepseek-v4-pro');
  });
});
