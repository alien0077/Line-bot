import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const geminiMocks = vi.hoisted(() => ({
  analyzeText: vi.fn(),
  answerGroupQuestion: vi.fn(),
  classifyTopic: vi.fn(),
  generateGeminiText: vi.fn()
}));

const storeMocks = vi.hoisted(() => ({
  addRecord: vi.fn(),
  findRecordByMessageId: vi.fn()
}));

vi.mock('../src/services/gemini.js', () => ({
  analyzeText: geminiMocks.analyzeText,
  answerGroupQuestion: geminiMocks.answerGroupQuestion,
  classifyTopic: geminiMocks.classifyTopic,
  getAnalysisMode: vi.fn(() => 'gemini'),
  generateGeminiText: geminiMocks.generateGeminiText
}));

vi.mock('../src/services/store.js', () => ({
  addRecord: storeMocks.addRecord,
  findRecordByMessageId: storeMocks.findRecordByMessageId
}));

function textEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    timestamp: Date.now(),
    source: {
      type: 'group',
      groupId: 'group-1',
      userId: 'user-1'
    },
    replyToken: 'reply-token',
    message: {
      id: `message-${Math.random()}`,
      type: 'text',
      text: '一般訊息'
    },
    ...overrides
  };
}

function mentionEvent(overrides: Record<string, unknown> = {}) {
  return textEvent({
    message: {
      id: `message-${Math.random()}`,
      type: 'text',
      text: '@Line-bot 這週有什麼待辦？',
      mention: {
        mentionees: [{ index: 0, length: 9, type: 'user', userId: 'Ubot', isSelf: true }]
      }
    },
    ...overrides
  });
}

function replyMentionEvent(overrides: Record<string, unknown> = {}) {
  return textEvent({
    message: {
      id: `message-${Math.random()}`,
      type: 'text',
      text: '@Line-bot 加入行事曆',
      quotedMessageId: 'quoted-msg-1',
      mention: {
        mentionees: [{ index: 0, length: 9, type: 'user', userId: 'Ubot', isSelf: true }]
      }
    },
    ...overrides
  });
}

function waitForAsync(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 50));
}

async function loadApp(options: { qaEnabled?: boolean; archiveAiMode?: string } = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('ALLOW_UNSIGNED_WEBHOOKS', 'true');
  vi.stubEnv('LINE_CHANNEL_SECRET', '');
  vi.stubEnv('LINE_CHANNEL_ACCESS_TOKEN', 'line-token');
  vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
  vi.stubEnv('LINE_BOT_QA_ENABLED', String(options.qaEnabled ?? true));
  if (options.archiveAiMode) vi.stubEnv('ARCHIVE_AI_MODE', options.archiveAiMode);

  geminiMocks.analyzeText.mockResolvedValue({ category: '閒聊', summary: '測試摘要' });
  geminiMocks.answerGroupQuestion.mockResolvedValue('這是 Gemini 回答');
  geminiMocks.classifyTopic.mockResolvedValue({
    topicId: 'topic-1',
    topicTitle: '測試主題',
    topicSummary: '測試主題摘要',
    topicConfidence: 0.9
  });
  storeMocks.addRecord.mockResolvedValue(undefined);
  storeMocks.findRecordByMessageId.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

  const { createApp } = await import('../src/app.js');
  return createApp();
}

describe('LINE webhook Gemini QA', () => {
  beforeEach(() => {
    geminiMocks.analyzeText.mockReset();
    geminiMocks.answerGroupQuestion.mockReset();
    geminiMocks.classifyTopic.mockReset();
    geminiMocks.generateGeminiText.mockReset();
    storeMocks.addRecord.mockReset();
    storeMocks.findRecordByMessageId.mockReset();
    storeMocks.findRecordByMessageId.mockResolvedValue(undefined);
    vi.unstubAllGlobals();
  });

  it('archives normal messages without replying', async () => {
    const app = await loadApp();

    const response = await request(app)
      .post('/webhook/line')
      .send({ events: [textEvent()] })
      .expect(200);

    expect(response.body).toEqual({ ok: true, received: 1 });
    expect(geminiMocks.analyzeText).toHaveBeenCalledWith('一般訊息', '其他', { forceLocal: true });
    expect(geminiMocks.classifyTopic).toHaveBeenCalledWith(expect.any(Object), { forceLocal: true });
    expect(geminiMocks.answerGroupQuestion).not.toHaveBeenCalled();
  });

  it('can opt into AI archive analysis for all messages', async () => {
    const app = await loadApp({ archiveAiMode: 'all' });

    const response = await request(app)
      .post('/webhook/line')
      .send({ events: [textEvent()] })
      .expect(200);

    expect(response.body).toEqual({ ok: true, received: 1 });
    expect(geminiMocks.analyzeText).toHaveBeenCalledWith('一般訊息', '其他', { forceLocal: false });
    expect(geminiMocks.classifyTopic).toHaveBeenCalledWith(expect.any(Object), { forceLocal: false });
  });

  it('answers with Gemini and LINE reply when the bot is mentioned', async () => {
    const app = await loadApp();

    const response = await request(app)
      .post('/webhook/line')
      .send({ events: [mentionEvent()] })
      .expect(200);

    expect(response.body).toEqual({ ok: true, received: 1 });
    await waitForAsync();
    expect(geminiMocks.analyzeText).toHaveBeenCalledWith('@Line-bot 這週有什麼待辦？', '其他', { forceLocal: true });
    expect(geminiMocks.classifyTopic).toHaveBeenCalledWith(expect.any(Object), { forceLocal: true });
    expect(geminiMocks.answerGroupQuestion).toHaveBeenCalledWith('這週有什麼待辦？', 'group-1');
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.line.me/v2/bot/message/reply');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      replyToken: 'reply-token',
      messages: [{ type: 'text', text: '這是 Gemini 回答' }]
    });
  });

  it('parses quoted message for calendar when replying with @mention', async () => {
    const app = await loadApp();
    storeMocks.findRecordByMessageId.mockResolvedValue({
      messageId: 'quoted-msg-1',
      content: '明天下午三點在老地方開會',
      messageType: 'text'
    } as never);
    const tomorrow = new Date(Date.now() + 86400000);
    const startStr = `${tomorrow.toISOString().slice(0, 10)}T15:00:00+08:00`;
    const endStr = `${tomorrow.toISOString().slice(0, 10)}T16:00:00+08:00`;
    geminiMocks.generateGeminiText.mockResolvedValue(JSON.stringify({
      title: '在老地方開會',
      startTime: startStr,
      endTime: endStr,
      location: '老地方',
      description: '明天下午三點在老地方開會',
      confidence: 0.9
    }));

    const response = await request(app)
      .post('/webhook/line')
      .send({ events: [replyMentionEvent()] })
      .expect(200);

    expect(response.body).toEqual({ ok: true, received: 1 });
    await waitForAsync();
    expect(storeMocks.findRecordByMessageId).toHaveBeenCalledWith('quoted-msg-1');
    expect(geminiMocks.answerGroupQuestion).not.toHaveBeenCalled();
  });

  it('falls back to Q&A when quoted message has no calendar keywords', async () => {
    const app = await loadApp();
    storeMocks.findRecordByMessageId.mockResolvedValue({
      messageId: 'quoted-msg-1',
      content: '今天天氣真好',
      messageType: 'text'
    } as never);

    const response = await request(app)
      .post('/webhook/line')
      .send({ events: [replyMentionEvent()] })
      .expect(200);

    expect(response.body).toEqual({ ok: true, received: 1 });
    await waitForAsync();
    expect(storeMocks.findRecordByMessageId).toHaveBeenCalledWith('quoted-msg-1');
    expect(geminiMocks.answerGroupQuestion).toHaveBeenCalledWith('加入行事曆', 'group-1');
  });

  it('falls back to Q&A when quoted message is not found in store', async () => {
    const app = await loadApp();

    const response = await request(app)
      .post('/webhook/line')
      .send({ events: [replyMentionEvent()] })
      .expect(200);

    expect(response.body).toEqual({ ok: true, received: 1 });
    await waitForAsync();
    expect(storeMocks.findRecordByMessageId).toHaveBeenCalledWith('quoted-msg-1');
    expect(geminiMocks.answerGroupQuestion).toHaveBeenCalledWith('加入行事曆', 'group-1');
  });

  it('answers a mention before archiving that mention as a new record', async () => {
    const app = await loadApp();
    const callOrder: string[] = [];
    geminiMocks.answerGroupQuestion.mockImplementation(async () => {
      callOrder.push('answer');
      return '這是 Gemini 回答';
    });
    storeMocks.addRecord.mockImplementation(async () => {
      callOrder.push('store');
    });

    await request(app)
      .post('/webhook/line')
      .send({ events: [mentionEvent()] })
      .expect(200);

    await waitForAsync();
    expect(callOrder).toEqual(['answer', 'store']);
  });

  it('does not reply when a mentioned event has no reply token', async () => {
    const app = await loadApp();
    const event = mentionEvent({ replyToken: undefined });

    const response = await request(app)
      .post('/webhook/line')
      .send({ events: [event] })
      .expect(200);

    expect(response.body).toEqual({ ok: true, received: 1 });
    await waitForAsync();
    expect(geminiMocks.answerGroupQuestion).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not reply when LINE bot QA is disabled', async () => {
    const app = await loadApp({ qaEnabled: false });

    const response = await request(app)
      .post('/webhook/line')
      .send({ events: [mentionEvent()] })
      .expect(200);

    expect(response.body).toEqual({ ok: true, received: 1 });
    await waitForAsync();
    expect(geminiMocks.answerGroupQuestion).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends a friendly fallback reply when Gemini answering fails', async () => {
    const app = await loadApp();
    geminiMocks.answerGroupQuestion.mockRejectedValue(new Error('Gemini failed'));

    const response = await request(app)
      .post('/webhook/line')
      .send({ events: [mentionEvent()] })
      .expect(200);

    expect(response.body).toEqual({ ok: true, received: 1 });
    await waitForAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body)).messages[0].text).toContain('請稍後再問我一次');
  });
});
