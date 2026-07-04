import { beforeEach, describe, expect, it, vi } from 'vitest';

const genaiMocks = vi.hoisted(() => ({
  generateContent: vi.fn()
}));

const storeMocks = vi.hoisted(() => ({
  listRecordViews: vi.fn()
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(
    class {
      models = {
        generateContent: genaiMocks.generateContent
      };
    }
  )
}));

vi.mock('../src/services/store.js', () => ({
  listRecordViews: storeMocks.listRecordViews
}));

async function loadGemini(env: Record<string, string> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
  vi.stubEnv('GEMINI_MODEL', 'gemini-2.5-flash');
  vi.stubEnv('GEMINI_DAILY_LIMIT', '50');
  vi.stubEnv('GEMINI_GOOGLE_SEARCH_ENABLED', 'true');
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }

  const module = await import('../src/services/gemini.js');
  return module;
}

describe('Gemini group QA routing', () => {
  beforeEach(() => {
    genaiMocks.generateContent.mockReset();
    storeMocks.listRecordViews.mockReset();
    vi.unstubAllGlobals();
    genaiMocks.generateContent.mockResolvedValue({ text: '測試回答' });
    storeMocks.listRecordViews.mockResolvedValue([]);
  });

  it('answers general factual questions with Google Search grounding instead of group records', async () => {
    const { answerGroupQuestion } = await loadGemini();

    await answerGroupQuestion('今天國小開始放暑假了嗎', 'group-1');

    expect(storeMocks.listRecordViews).not.toHaveBeenCalled();
    expect(genaiMocks.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          tools: [{ googleSearch: {} }]
        }
      })
    );
  });

  it('uses group records only when the question asks about group context', async () => {
    const { answerGroupQuestion } = await loadGemini();
    storeMocks.listRecordViews.mockResolvedValue([
      {
        timestamp: '2026-07-01T04:00:00.000Z',
        groupId: 'group-1',
        groupName: '測試群組',
        messageType: 'text',
        category: '待辦',
        content: '明天要交報告',
        aiSummary: '提醒明天交報告',
        driveFileName: ''
      }
    ]);

    await answerGroupQuestion('群裡剛剛有什麼待辦？', 'group-1');

    expect(storeMocks.listRecordViews).toHaveBeenCalledTimes(1);
    expect(genaiMocks.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {}
      })
    );
    expect(genaiMocks.generateContent.mock.calls[0][0].contents).toContain('同群組歸檔紀錄');
  });

  it('filters archived bot mention commands out of group QA context', async () => {
    const { answerGroupQuestion } = await loadGemini();
    const now = new Date().toISOString();
    storeMocks.listRecordViews.mockResolvedValue([
      {
        timestamp: now,
        groupId: 'group-1',
        groupName: '測試群組',
        messageType: 'text',
        category: '問題',
        content: '@AlienLineBot 今天群組聊天內容主題有幾個',
        aiSummary: '詢問今天群組主題數',
        driveFileName: '',
        topicTitle: 'Bot 提問'
      },
      {
        timestamp: now,
        groupId: 'group-1',
        groupName: '測試群組',
        messageType: 'text',
        category: '公告',
        content: '明天 10 點開會討論報告',
        aiSummary: '提醒明天開會討論報告',
        driveFileName: '',
        topicTitle: '報告會議'
      }
    ]);

    await answerGroupQuestion('今天群組聊天內容主題有幾個', 'group-1');

    const prompt = genaiMocks.generateContent.mock.calls[0][0].contents;
    expect(prompt).toContain('明天 10 點開會討論報告');
    expect(prompt).toContain('主題：報告會議');
    expect(prompt).not.toContain('@AlienLineBot 今天群組聊天內容主題有幾個');
  });

  it('returns a deterministic no-context reply when only bot commands are archived', async () => {
    const { answerGroupQuestion } = await loadGemini();
    storeMocks.listRecordViews.mockResolvedValue([
      {
        timestamp: new Date().toISOString(),
        groupId: 'group-1',
        groupName: '測試群組',
        messageType: 'text',
        category: '問題',
        content: '@AlienLineBot 摘要今天群組聊天內容',
        aiSummary: '要求摘要聊天內容',
        driveFileName: '',
        topicTitle: 'Bot 提問'
      }
    ]);

    const answer = await answerGroupQuestion('摘要今天群組聊天內容，有沒有待處理事項', 'group-1');

    expect(answer).toContain('沒有在 Google Sheets 讀到今天這個群組可供摘要的聊天文字或歸檔索引');
    expect(answer).toContain('Google Drive 主要保存圖片與檔案本體');
    expect(answer).toContain('LINE webhook');
    expect(genaiMocks.generateContent).not.toHaveBeenCalled();
  });

  it('returns a clear quota message instead of throwing when Gemini quota is exhausted', async () => {
    const { answerGroupQuestion } = await loadGemini();
    const quotaError = Object.assign(new Error('RESOURCE_EXHAUSTED: free_tier_requests quota exceeded'), {
      status: 429
    });
    genaiMocks.generateContent.mockRejectedValue(quotaError);

    const answer = await answerGroupQuestion('今天台南天氣如何？', 'group-1');

    expect(answer).toContain('Gemini 今日免費額度可能已用完');
    expect(genaiMocks.generateContent).toHaveBeenCalledTimes(1);
  });

  it('falls back to OpenRouter when Gemini quota is exhausted', async () => {
    const { answerGroupQuestion } = await loadGemini({
      OPENROUTER_API_KEY: 'openrouter-key',
      OPENROUTER_MODEL: 'openrouter/auto'
    });
    const quotaError = Object.assign(new Error('RESOURCE_EXHAUSTED: free_tier_requests quota exceeded'), {
      status: 429
    });
    genaiMocks.generateContent.mockRejectedValue(quotaError);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'OpenRouter 備援回答' } }]
    }), { status: 200 })));

    const answer = await answerGroupQuestion('今天台南天氣如何？', 'group-1');

    expect(answer).toBe('OpenRouter 備援回答');
    expect(fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST'
      })
    );
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'openrouter/auto',
      plugins: [{ id: 'web' }]
    });
  });

  it('uses smarter local rules for archive analysis and topics', async () => {
    const { analyzeText, classifyTopic } = await loadGemini();

    const analysis = await analyzeText('請問貝貝南瓜怎麼烤？', '其他', { forceLocal: true });
    const topic = await classifyTopic({
      groupId: 'group-1',
      messageType: 'text',
      content: '請問貝貝南瓜怎麼烤？',
      category: analysis.category,
      driveFileName: '',
      mimeType: '',
      aiSummary: analysis.summary
    }, { forceLocal: true });

    expect(analysis.category).toBe('問題');
    expect(topic.topicTitle).toContain('貝貝南瓜');
    expect(topic.topicId).toContain('貝貝南瓜');
    expect(topic.topicConfidence).toBeGreaterThan(0.35);
  });
});
