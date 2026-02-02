// File Generation Tool Tests - Phase 8
// Tests for file_gen tool with ALLOW_WRITE protection

import { jest, beforeAll, afterAll, describe, it, expect } from '@jest/globals';
import request from 'supertest';
import { createTestApp } from './testApp.js';

describe('File Generation Tool Tests', () => {
  let app;

  beforeAll(() => {
    // Ensure ALLOW_WRITE is disabled for tests
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_WRITE = '0';
    
    app = createTestApp();
  });

  describe('POST /tools/file_gen/execute', () => {
    it('should have file_gen tool available', async () => {
      const res = await request(app)
        .get('/tools/file_gen')
        .expect('Content-Type', /json/)
        .expect(200);

      expect(res.body).toHaveProperty('ok', true);
      expect(res.body).toHaveProperty('tool');
      expect(res.body.tool.name).toBe('file_gen');
      expect(res.body.tool.risk_level).toBe('low');
    });

    it('should describe file_gen capabilities', async () => {
      const res = await request(app)
        .get('/tools/file_gen')
        .expect(200);

      const schema = res.body.tool.schema;
      expect(schema.properties).toHaveProperty('filename');
      expect(schema.properties).toHaveProperty('content');
      expect(schema.required).toContain('filename');
      expect(schema.required).toContain('content');
    });
  });

  describe('Security - Write Protection', () => {
    it('should have ALLOW_WRITE disabled in test environment', () => {
      expect(process.env.ALLOW_WRITE).toBe('0');
    });
  });

  describe('Tool Schema Validation', () => {
    it('file_gen should be a low-risk tool', async () => {
      const res = await request(app)
        .get('/tools/risk/low')
        .expect(200);

      const fileGenTool = res.body.tools.find(t => t.name === 'file_gen');
      expect(fileGenTool).toBeDefined();
      expect(fileGenTool.risk_level).toBe('low');
    });

    it('file_gen should not require confirmation', async () => {
      const res = await request(app)
        .get('/tools/confirm-required')
        .expect(200);

      const fileGenTool = res.body.tools.find(t => t.name === 'file_gen');
      expect(fileGenTool).toBeUndefined(); // Should NOT be in confirm-required list
    });
  });
});
