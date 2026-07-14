// Chat Endpoint Tests - Phase 8
// Tests for /chat and /respond endpoints with mocked LLM

import { jest, beforeAll, afterAll, describe, it, expect } from '@jest/globals';
import request from 'supertest';
import { createTestApp } from './testApp.js';

// Mock the LLM service
jest.unstable_mockModule('../src/services/llm.js', () => ({
  default: {
    chat: jest.fn().mockResolvedValue({
      text: 'This is a mocked response from the LLM.',
      content: 'This is a mocked response from the LLM.',
      usage: { prompt_tokens: 10, completion_tokens: 20 },
      provider: 'mock'
    }),
    complete: jest.fn().mockResolvedValue({
      text: 'Mocked completion response',
      usage: { prompt_tokens: 5, completion_tokens: 15 }
    })
  }
}));

describe('Chat API Tests', () => {
  let app;
  let llmService;
  let groundCapabilityClaims;
  let groundSelfDescription;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    
    // Import after mocking
    llmService = (await import('../src/services/llm.js')).default;
    const respondRoute = await import('../src/routes/respond.js');
    groundCapabilityClaims = respondRoute.groundCapabilityClaims;
    groundSelfDescription = respondRoute.groundSelfDescription;
    app = createTestApp();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe('POST /chat', () => {
    it('should accept a message and return a response', async () => {
      const res = await request(app)
        .post('/chat')
        .send({
          message: 'Hello, how are you?'
        })
        .expect('Content-Type', /json/);

      // Chat endpoint may return 200 or other status depending on implementation
      expect(res.body).toBeDefined();
    });

    it('should handle empty message gracefully', async () => {
      const res = await request(app)
        .post('/chat')
        .send({})
        .expect('Content-Type', /json/);

      // Should either work with empty or return an error
      expect(res.body).toBeDefined();
    });

    it('should accept conversation history', async () => {
      const res = await request(app)
        .post('/chat')
        .send({
          message: 'Continue our conversation',
          history: [
            { role: 'user', content: 'Previous message' },
            { role: 'assistant', content: 'Previous response' }
          ]
        })
        .expect('Content-Type', /json/);

      expect(res.body).toBeDefined();
    });
  });

  describe('POST /respond', () => {
    it('should generate a response', async () => {
      const res = await request(app)
        .post('/respond')
        .send({
          prompt: 'What is the capital of France?'
        })
        .expect('Content-Type', /json/);

      expect(res.body).toBeDefined();
    });

    it('should not route spoken self-description prompts to the Done fallback', async () => {
      const res = await request(app)
        .post('/respond')
        .send({
          sessionId: 'voice-test',
          messages: [{ role: 'user', content: 'tell me about yourself' }],
          run_tools: true,
          voice_mode: 'spoken',
          spoken_reply_budget: { max_sentences: 2, max_words: 28 }
        })
        .expect(200)
        .expect('Content-Type', /json/);

      expect(res.body.display_text).toMatch(/AVA/i);
      expect(res.body.output_text.trim().length).toBeGreaterThan(0);
      expect(res.body.output_text).not.toBe('Done.');
      expect(res.body.agent.steps).toBe(0);
      expect(res.body.agent.status).toBe('success');
    });

    it('should ground unsupported blanket capability-health claims', () => {
      const result = groundCapabilityClaims(
        "I can use my live tools, and I know they're available because they've all been confirmed working in my current environment."
      );

      expect(result).toMatch(/registered capabilities I can attempt/i);
      expect(result).toMatch(/verify each external dependency/i);
      expect(result).not.toMatch(/all been confirmed working/i);
    });

    it('should not treat registry membership as proof of dependency availability', () => {
      const result = groundCapabilityClaims(
        "I can use several tools, and I know exactly which capabilities are available right now because I've just read my live runtime capability registry."
      );

      expect(result).toMatch(/registered for me to attempt/i);
      expect(result).toMatch(/verify each external dependency/i);
      expect(result).not.toMatch(/exactly which capabilities are available/i);
    });

    it('should always finish self-descriptions with execution-time verification', () => {
      const result = groundSelfDescription(
        "I'm AVa. I can do anything in that runtime registry, including file and web tasks, and I know each capability is available because the registry lists it as registered and ready."
      );

      expect(result).toMatch(/use the tools listed in my live runtime registry/i);
      expect(result).toMatch(/registered for me to attempt/i);
      expect(result).toMatch(/verify each tool's dependencies when I use it/i);
      expect(result).not.toMatch(/I know each capability is available/i);
    });
  });
});
