// Idempotency Cache Tests - Phase 8
// Tests for tool execution boundary idempotency

import { jest } from '@jest/globals';
import request from 'supertest';
import { createTestApp } from './testApp.js';
import { IdempotencyCache } from '../src/services/tools.js';
import toolsService from '../src/services/tools.js';

describe('Idempotency Cache Tests', () => {
  let app;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_WRITE = '0';
    app = createTestApp();
  });

  beforeEach(() => {
    // Clear the idempotency cache before each test
    toolsService.clearIdempotencyCache();
  });

  // ============================================
  // IdempotencyCache Unit Tests
  // ============================================
  describe('IdempotencyCache class', () => {
    let cache;

    beforeEach(() => {
      cache = new IdempotencyCache(1000); // 1 second TTL for fast tests
    });

    describe('normalizeArgs', () => {
      it('should sort object keys', () => {
        const result = cache.normalizeArgs({ z: 1, a: 2, m: 3 });
        expect(Object.keys(result)).toEqual(['a', 'm', 'z']);
      });

      it('should trim whitespace from strings', () => {
        const result = cache.normalizeArgs({ text: '  hello world  ' });
        expect(result.text).toBe('hello world');
      });

      it('should lowercase strings', () => {
        const result = cache.normalizeArgs({ text: 'HELLO World' });
        expect(result.text).toBe('hello world');
      });

      it('should remove volatile fields', () => {
        const result = cache.normalizeArgs({
          query: 'test',
          timestamp: 12345,
          request_id: 'abc-123',
          nonce: 'xyz'
        });
        expect(result).toEqual({ query: 'test' });
        expect(result.timestamp).toBeUndefined();
        expect(result.request_id).toBeUndefined();
        expect(result.nonce).toBeUndefined();
      });

      it('should handle nested objects', () => {
        const result = cache.normalizeArgs({
          outer: { z: 1, a: 2 },
          value: 'TEST'
        });
        expect(Object.keys(result.outer)).toEqual(['a', 'z']);
        expect(result.value).toBe('test');
      });

      it('should handle arrays', () => {
        const result = cache.normalizeArgs({
          items: ['B', 'A', 'C']
        });
        expect(result.items).toEqual(['b', 'a', 'c']);
      });

      it('should handle null and undefined', () => {
        expect(cache.normalizeArgs(null)).toBeNull();
        expect(cache.normalizeArgs(undefined)).toBeNull();
      });
    });

    describe('generateKey', () => {
      it('should generate deterministic keys', () => {
        const key1 = cache.generateKey('test_tool', { a: 1, b: 2 });
        const key2 = cache.generateKey('test_tool', { b: 2, a: 1 });
        expect(key1).toBe(key2);
      });

      it('should generate different keys for different tools', () => {
        const key1 = cache.generateKey('tool_a', { x: 1 });
        const key2 = cache.generateKey('tool_b', { x: 1 });
        expect(key1).not.toBe(key2);
      });

      it('should generate different keys for different args', () => {
        const key1 = cache.generateKey('test', { x: 1 });
        const key2 = cache.generateKey('test', { x: 2 });
        expect(key1).not.toBe(key2);
      });

      it('should be case-insensitive for tool names', () => {
        const key1 = cache.generateKey('TEST_TOOL', { a: 1 });
        const key2 = cache.generateKey('test_tool', { a: 1 });
        expect(key1).toBe(key2);
      });
    });

    describe('check and record', () => {
      it('should not block first execution', () => {
        const result = cache.check('test_tool', { query: 'hello' });
        expect(result.blocked).toBe(false);
      });

      it('should block repeated execution within TTL', () => {
        const args = { query: 'hello' };

        // First call - record
        cache.record('test_tool', args);

        // Second call - should be blocked
        const result = cache.check('test_tool', args);
        expect(result.blocked).toBe(true);
        expect(result.ageMs).toBeDefined();
        expect(result.ageMs).toBeLessThan(1000);
      });

      it('should allow execution after TTL expires', async () => {
        const shortCache = new IdempotencyCache(100); // 100ms TTL
        const args = { query: 'hello' };

        // Record first execution
        shortCache.record('test_tool', args);

        // Wait for TTL to expire
        await new Promise(resolve => setTimeout(resolve, 150));

        // Should not be blocked now
        const result = shortCache.check('test_tool', args);
        expect(result.blocked).toBe(false);
      });

      it('should distinguish different tool+args combinations', () => {
        cache.record('tool_a', { x: 1 });
        cache.record('tool_b', { x: 2 });

        // Different tool - not blocked
        const result1 = cache.check('tool_c', { x: 1 });
        expect(result1.blocked).toBe(false);

        // Different args - not blocked
        const result2 = cache.check('tool_a', { x: 99 });
        expect(result2.blocked).toBe(false);

        // Same tool+args - blocked
        const result3 = cache.check('tool_a', { x: 1 });
        expect(result3.blocked).toBe(true);
      });
    });

    describe('clear', () => {
      it('should clear all entries', () => {
        cache.record('tool1', { a: 1 });
        cache.record('tool2', { b: 2 });

        expect(cache.stats().size).toBe(2);

        cache.clear();

        expect(cache.stats().size).toBe(0);
        expect(cache.check('tool1', { a: 1 }).blocked).toBe(false);
      });
    });
  });

  // ============================================
  // Integration Tests via API
  // ============================================
  describe('Tool Execution Idempotency (API)', () => {
    it('should execute tool on first call', async () => {
      const res = await request(app)
        .post('/tools/status/execute')
        .send({ args: {} })
        .expect(200);

      expect(res.body.ok).toBe(true);
    });

    it('should block repeated tool execution within TTL', async () => {
      // Clear cache first
      await request(app).post('/tools/idempotency/clear');

      // First execution
      const res1 = await request(app)
        .post('/tools/status/execute')
        .send({ args: {}, source: 'test' })
        .expect(200);

      expect(res1.body.ok).toBe(true);

      // Second execution with same args - should be blocked
      const res2 = await request(app)
        .post('/tools/status/execute')
        .send({ args: {}, source: 'test' })
        .expect(200);

      expect(res2.body.ok).toBe(false);
      expect(res2.body.reason).toBe('idempotency_blocked');
      expect(res2.body.error).toContain('already did that recently');
    });

    it('should allow execution with bypassIdempotency flag', async () => {
      // Clear cache first
      await request(app).post('/tools/idempotency/clear');

      // First execution
      await request(app)
        .post('/tools/status/execute')
        .send({ args: {} })
        .expect(200);

      // Second execution with bypass - should succeed
      const res = await request(app)
        .post('/tools/status/execute')
        .send({ args: {}, bypassIdempotency: true })
        .expect(200);

      expect(res.body.ok).toBe(true);
    });

    it('should not block dry_run executions', async () => {
      // Clear cache first
      await request(app).post('/tools/idempotency/clear');

      // Dry run should not record to cache
      await request(app)
        .post('/tools/status/execute')
        .send({ args: {}, dry_run: true })
        .expect(200);

      // Real execution should still work
      const res = await request(app)
        .post('/tools/status/execute')
        .send({ args: {} })
        .expect(200);

      expect(res.body.ok).toBe(true);
    });

    it('should allow different args for same tool', async () => {
      // Clear cache first
      await request(app).post('/tools/idempotency/clear');

      // Execute with args1
      await request(app)
        .post('/tools/memory_search/execute')
        .send({ args: { query: 'first query' } })
        .expect(200);

      // Execute with different args - should work
      const res = await request(app)
        .post('/tools/memory_search/execute')
        .send({ args: { query: 'second query' } })
        .expect(200);

      expect(res.body.ok).toBe(true);
    });
  });

  // ============================================
  // Cache Statistics Tests
  // ============================================
  describe('Idempotency Cache Stats (API)', () => {
    it('should return cache statistics', async () => {
      const res = await request(app)
        .get('/tools/idempotency/stats')
        .expect(200);

      expect(res.body.ok).toBe(true);
      expect(res.body.stats).toHaveProperty('size');
      expect(res.body.stats).toHaveProperty('ttlMs');
    });

    it('should clear cache via API', async () => {
      // Execute a tool to populate cache
      await request(app)
        .post('/tools/status/execute')
        .send({ args: {} });

      // Clear the cache
      const clearRes = await request(app)
        .post('/tools/idempotency/clear')
        .expect(200);

      expect(clearRes.body.ok).toBe(true);
      expect(clearRes.body.message).toBe('Idempotency cache cleared');

      // Verify cache is empty
      const statsRes = await request(app)
        .get('/tools/idempotency/stats')
        .expect(200);

      expect(statsRes.body.stats.size).toBe(0);
    });
  });

  // ============================================
  // Edge Cases
  // ============================================
  describe('Edge Cases', () => {
    it('should handle empty args', async () => {
      await request(app).post('/tools/idempotency/clear');

      // Execute with no args
      await request(app)
        .post('/tools/status/execute')
        .send({})
        .expect(200);

      // Second call should be blocked
      const res = await request(app)
        .post('/tools/status/execute')
        .send({})
        .expect(200);

      expect(res.body.reason).toBe('idempotency_blocked');
    });

    it('should be case-insensitive for string args', async () => {
      await request(app).post('/tools/idempotency/clear');

      // Execute with lowercase
      await request(app)
        .post('/tools/memory_search/execute')
        .send({ args: { query: 'hello world' } })
        .expect(200);

      // Execute with uppercase - should be blocked (normalized to same)
      const res = await request(app)
        .post('/tools/memory_search/execute')
        .send({ args: { query: 'HELLO WORLD' } })
        .expect(200);

      expect(res.body.reason).toBe('idempotency_blocked');
    });

    it('should ignore volatile fields in args', async () => {
      await request(app).post('/tools/idempotency/clear');

      // Execute with timestamp
      await request(app)
        .post('/tools/memory_search/execute')
        .send({ args: { query: 'test', timestamp: 1234 } })
        .expect(200);

      // Execute with different timestamp - should still be blocked
      const res = await request(app)
        .post('/tools/memory_search/execute')
        .send({ args: { query: 'test', timestamp: 9999 } })
        .expect(200);

      expect(res.body.reason).toBe('idempotency_blocked');
    });
  });
});
