import { describe, expect, it, vi } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('LINE_CHANNEL_SECRET', 'secret');
vi.stubEnv('ALLOW_UNSIGNED_WEBHOOKS', 'false');

const { isBotMentioned, stripMentionText, verifyLineSignature } = await import('../src/services/line.js');

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

  it('detects a real mention to the bot', () => {
    expect(
      isBotMentioned({
        type: 'message',
        message: {
          type: 'text',
          text: '@Line-bot 這週有什麼待辦？',
          mention: {
            mentionees: [{ index: 0, length: 9, type: 'user', userId: 'Ubot', isSelf: true }]
          }
        }
      })
    ).toBe(true);
  });

  it('does not treat plain text as a bot mention without LINE mention metadata', () => {
    expect(
      isBotMentioned({
        type: 'message',
        message: {
          type: 'text',
          text: '@Line-bot 這週有什麼待辦？'
        }
      })
    ).toBe(false);
  });

  it('removes the bot mention from the question text', () => {
    expect(
      stripMentionText({
        type: 'message',
        message: {
          type: 'text',
          text: '@Line-bot 這週有什麼待辦？',
          mention: {
            mentionees: [{ index: 0, length: 9, type: 'user', userId: 'Ubot', isSelf: true }]
          }
        }
      })
    ).toBe('這週有什麼待辦？');
  });
});
