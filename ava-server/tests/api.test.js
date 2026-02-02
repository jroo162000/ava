// API Endpoint Tests - Phase 8
// Tests for core AVA server endpoints

import { jest } from '@jest/globals';
import request from 'supertest';
import { createTestApp } from './testApp.js';

describe('AVA Server API Tests', () => {
  let app;

  beforeAll(() => {
    // Set test environment
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_WRITE = '0';
    
    app = createTestApp();
  });

  afterAll(() => {
    // Cleanup
  });

  // ============================================
  // Health Check Tests
  // ============================================
  describe('GET /health', () => {
    it('should return healthy status', async () => {
      const res = await request(app)
        .get('/health')
        .expect('Content-Type', /json/)
        .expect(200);

      expect(res.body).toHaveProperty('ok', true);
      expect(res.body).toHaveProperty('timestamp');
      expect(res.body).toHaveProperty('build');
    });

    it('should include allowWrite setting', async () => {
      const res = await request(app)
        .get('/health')
        .expect(200);

      expect(res.body).toHaveProperty('allowWrite');
      expect(typeof res.body.allowWrite).toBe('boolean');
    });
  });

  // Use /metrics for detailed memory info
  describe('GET /metrics', () => {
    it('should return memory usage', async () => {
      const res = await request(app)
        .get('/metrics')
        .expect('Content-Type', /json/)
        .expect(200);

      expect(res.body).toHaveProperty('memory');
      expect(res.body.memory).toHaveProperty('heapUsed');
      expect(res.body).toHaveProperty('uptime');
    });
  });

  // ============================================
  // Memory Tests
  // ============================================
  describe('Memory Endpoints', () => {
    describe('GET /memory/stats', () => {
      it('should return memory statistics', async () => {
        const res = await request(app)
          .get('/memory/stats')
          .expect('Content-Type', /json/)
          .expect(200);

        expect(res.body).toHaveProperty('ok', true);
        expect(res.body).toHaveProperty('stats');
        expect(res.body.stats).toHaveProperty('count');
        expect(res.body.stats).toHaveProperty('storage');
      });
    });

    describe('POST /memory/store', () => {
      it('should store a memory item', async () => {
        const res = await request(app)
          .post('/memory/store')
          .send({
            text: 'Test memory item from Jest',
            type: 'fact',
            priority: 3
          })
          .expect('Content-Type', /json/)
          .expect(200);

        expect(res.body).toHaveProperty('ok', true);
        expect(res.body).toHaveProperty('memory');
        expect(res.body.memory).toHaveProperty('id');
        expect(res.body.memory).toHaveProperty('text', 'Test memory item from Jest');
        expect(res.body.memory).toHaveProperty('type', 'fact');
      });

      it('should reject empty text', async () => {
        const res = await request(app)
          .post('/memory/store')
          .send({})
          .expect('Content-Type', /json/)
          .expect(400);

        expect(res.body).toHaveProperty('ok', false);
        expect(res.body).toHaveProperty('error');
      });
    });

    describe('POST /memory/search', () => {
      it('should search memories', async () => {
        // First store a memory
        await request(app)
          .post('/memory/store')
          .send({
            text: 'Unique test phrase XYZ123',
            type: 'fact'
          });

        // Then search for it
        const res = await request(app)
          .post('/memory/search')
          .send({
            query: 'unique test phrase',
            k: 5
          })
          .expect('Content-Type', /json/)
          .expect(200);

        expect(res.body).toHaveProperty('ok', true);
        expect(res.body).toHaveProperty('results');
        expect(Array.isArray(res.body.results)).toBe(true);
      });

      it('should reject empty query', async () => {
        const res = await request(app)
          .post('/memory/search')
          .send({})
          .expect('Content-Type', /json/)
          .expect(400);

        expect(res.body).toHaveProperty('ok', false);
        expect(res.body.error).toContain('required');
      });
    });

    describe('POST /memory/learn/preference', () => {
      it('should store a preference', async () => {
        const res = await request(app)
          .post('/memory/learn/preference')
          .send({
            text: 'User prefers dark mode'
          })
          .expect('Content-Type', /json/)
          .expect(200);

        expect(res.body).toHaveProperty('ok', true);
        expect(res.body.memory).toHaveProperty('type', 'preference');
        expect(res.body.memory).toHaveProperty('priority', 4);
      });
    });
  });

  // ============================================
  // Security Tests
  // ============================================
  describe('Security Endpoints', () => {
    describe('GET /security/status', () => {
      it('should return security status', async () => {
        const res = await request(app)
          .get('/security/status')
          .expect('Content-Type', /json/)
          .expect(200);

        expect(res.body).toHaveProperty('ok', true);
        expect(res.body).toHaveProperty('security');
        expect(res.body.security).toHaveProperty('initialized');
        expect(res.body.security).toHaveProperty('allowedDirectories');
        expect(res.body.security).toHaveProperty('highRiskTools');
      });
    });

    describe('POST /security/validate-path', () => {
      it('should validate safe paths', async () => {
        const res = await request(app)
          .post('/security/validate-path')
          .send({
            path: 'C:\\Users\\test\\documents\\file.txt',
            operation: 'read'
          })
          .expect('Content-Type', /json/)
          .expect(200);

        expect(res.body).toHaveProperty('ok', true);
        expect(res.body.validation).toHaveProperty('valid');
      });

      it('should block path traversal', async () => {
        const res = await request(app)
          .post('/security/validate-path')
          .send({
            path: 'C:\\Users\\test\\..\\..\\Windows\\System32',
            operation: 'read'
          })
          .expect(200);

        expect(res.body.validation).toHaveProperty('valid', false);
        expect(res.body.validation.reason).toContain('Blocked');
      });
    });
  });

  // ============================================
  // Tools Tests
  // ============================================
  describe('Tools Endpoints', () => {
    describe('GET /tools', () => {
      it('should list available tools', async () => {
        const res = await request(app)
          .get('/tools')
          .expect('Content-Type', /json/)
          .expect(200);

        expect(res.body).toHaveProperty('ok', true);
        expect(res.body).toHaveProperty('tools');
        expect(Array.isArray(res.body.tools)).toBe(true);
        expect(res.body).toHaveProperty('count');
      });

      it('should include builtin tools', async () => {
        const res = await request(app)
          .get('/tools')
          .expect(200);

        const toolNames = res.body.tools.map(t => t.name);
        expect(toolNames).toContain('file_gen');
        expect(toolNames).toContain('status');
      });
    });

    describe('GET /tools/confirm-required', () => {
      it('should list tools requiring confirmation', async () => {
        const res = await request(app)
          .get('/tools/confirm-required')
          .expect('Content-Type', /json/)
          .expect(200);

        expect(res.body).toHaveProperty('ok', true);
        expect(res.body).toHaveProperty('tools');
        
        // All returned tools should require confirmation
        for (const tool of res.body.tools) {
          expect(tool.requires_confirm).toBe(true);
        }
      });
    });

    describe('GET /tools/risk/:level', () => {
      it('should filter tools by risk level', async () => {
        const res = await request(app)
          .get('/tools/risk/low')
          .expect('Content-Type', /json/)
          .expect(200);

        expect(res.body).toHaveProperty('ok', true);
        expect(res.body).toHaveProperty('riskLevel', 'low');
        
        // All returned tools should be low risk
        for (const tool of res.body.tools) {
          expect(tool.risk_level).toBe('low');
        }
      });

      it('should reject invalid risk level', async () => {
        const res = await request(app)
          .get('/tools/risk/invalid')
          .expect(400);

        expect(res.body).toHaveProperty('ok', false);
      });
    });

    describe('POST /tools/:name/execute - High Risk Protection', () => {
      it('should return 404 for unavailable tools', async () => {
        // Python worker may not be ready in test environment
        // This tests that unknown tools get proper 404
        const res = await request(app)
          .post('/tools/nonexistent_tool/execute')
          .send({
            args: { test: 'value' }
          })
          .expect(404);

        expect(res.body).toHaveProperty('ok', false);
        expect(res.body.error).toContain('not found');
      });

      it('should execute builtin tools without confirmation when low-risk', async () => {
        const res = await request(app)
          .post('/tools/status/execute')
          .send({})
          .expect(200);

        expect(res.body).toHaveProperty('ok', true);
      });
    });
  });

  // ============================================
  // 404 Handler Tests
  // ============================================
  describe('404 Handler', () => {
    it('should return 404 for unknown routes', async () => {
      const res = await request(app)
        .get('/nonexistent/route')
        .expect('Content-Type', /json/)
        .expect(404);

      expect(res.body).toHaveProperty('ok', false);
      expect(res.body).toHaveProperty('error', 'Route not found');
    });
  });
});
