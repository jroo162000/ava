// Doctor & Maintenance Tests

import request from 'supertest';
import { createTestApp } from './testApp.js';

describe('Doctor & Maintenance', () => {
  let app;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_WRITE = '0';
    app = createTestApp();
  });

  it('POST /self/doctor (propose) should return report and proposals', async () => {
    const res = await request(app)
      .post('/self/doctor')
      .send({})
      .expect('Content-Type', /json/)
      .expect(200);

    expect(res.body).toHaveProperty('ok', true);
    expect(res.body).toHaveProperty('mode', 'propose');
    expect(res.body).toHaveProperty('reportPath');
    expect(res.body).toHaveProperty('proposalsPath');
    expect(res.body).toHaveProperty('report');
    expect(res.body.report).toHaveProperty('summary');
    expect(res.body.report.summary).toHaveProperty('status');
  });

  it('POST /self/doctor should validate mode', async () => {
    const res = await request(app)
      .post('/self/doctor')
      .send({ mode: 'invalid' })
      .expect('Content-Type', /json/)
      .expect(400);

    expect(res.body).toHaveProperty('ok', false);
  });
});

