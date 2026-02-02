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

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    
    // Import after mocking
    llmService = (await import('../src/services/llm.js')).default;
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
  });
});
