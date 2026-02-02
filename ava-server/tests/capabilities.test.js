// Capability and Explain endpoints

import request from 'supertest';
import { createTestApp } from './testApp.js';

describe('Capabilities + Explain', () => {
  let app;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    app = createTestApp();
  });

  it('GET /self/capabilities should return core fields', async () => {
    const res = await request(app)
      .get('/self/capabilities')
      .expect('Content-Type', /json/)
      .expect(200);

    expect(res.body).toHaveProperty('ok', true);
    expect(res.body).toHaveProperty('capabilities');
    const c = res.body.capabilities;
    expect(c).toHaveProperty('tools');
    expect(Array.isArray(c.tools)).toBe(true);
    expect(c).toHaveProperty('permissions');
    expect(c).toHaveProperty('write');
    expect(c).toHaveProperty('bridge');
    expect(c.bridge).toHaveProperty('port');
    expect(c).toHaveProperty('llmProvider');
  });

  it('GET /self/explain should provide identity, capability summary, and improvement model', async () => {
    const res = await request(app)
      .get('/self/explain')
      .expect('Content-Type', /json/)
      .expect(200);

    expect(res.body).toHaveProperty('ok', true);
    expect(res.body).toHaveProperty('who');
    expect(res.body).toHaveProperty('canDo');
    expect(res.body).toHaveProperty('improve');
    expect(res.body.who).toHaveProperty('name');
    expect(res.body.canDo).toHaveProperty('tools');
    expect(Array.isArray(res.body.canDo.tools)).toBe(true);
  });
});

