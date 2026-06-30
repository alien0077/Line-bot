import { describe, expect, it, vi } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('LINE_CHANNEL_SECRET', 'secret');
vi.stubEnv('ALLOW_UNSIGNED_WEBHOOKS', 'false');

const { verifyLineSignature } = await import('../src/services/line.js');

describe('LINE signature verification', () => {
  it('accepts a valid LINE signature', async () => {
    const { createHmac } = await import('node:crypto');
    const body = Buffer.from(JSON.stringify({ events: [] }));
    const signature = createHmac('sha256', 'secret').update(body).digest('base64');
    expect(verifyLineSignature(body, signature)).toBe(true);
  });

  it('rejects an invalid LINE signature', () => {
    const body = Buffer.from(JSON.stringify({ events: [] }));
    expect(verifyLineSignature(body, 'bad-signature')).toBe(false);
  });
});
