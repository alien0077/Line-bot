import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('ALLOW_UNSIGNED_WEBHOOKS', 'true');
vi.stubEnv('DASHBOARD_PASSWORD', 'test-password');
vi.stubEnv('SESSION_SECRET', 'test-session-secret');

const { createApp } = await import('../src/app.js');

describe('dashboard API', () => {
  const app = createApp();

  it('returns public summary without login', async () => {
    const response = await request(app).get('/api/public/summary').expect(200);
    expect(response.body.todayCount).toBeGreaterThanOrEqual(1);
    expect(response.body.storageMode).toBe('memory');
  });

  it('protects admin records with a password', async () => {
    await request(app).get('/api/admin/records').expect(401);

    const login = await request(app)
      .post('/api/admin/login')
      .send({ password: 'test-password' })
      .expect(200);

    const cookie = login.headers['set-cookie'];
    const records = await request(app).get('/api/admin/records').set('Cookie', cookie).expect(200);
    expect(records.body.records.length).toBeGreaterThanOrEqual(1);
  });
});
