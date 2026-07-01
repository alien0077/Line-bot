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

async function loadGemini() {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
  vi.stubEnv('GEMINI_MODEL', 'gemini-2.5-flash');
  vi.stubEnv('GEMINI_DAILY_LIMIT', '50');
  vi.stubEnv('GEMINI_GOOGLE_SEARCH_ENABLED', 'true');

  const module = await import('../src/services/gemini.js');
  return module;
}

describe('Gemini group QA routing', () => {
  beforeEach(() => {
    genaiMocks.generateContent.mockReset();
    storeMocks.listRecordViews.mockReset();
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

  it('returns a clear quota message instead of throwing when Gemini quota is exhausted', async () => {
    const { answerGroupQuestion } = await loadGemini();
    const quotaError = Object.assign(new Error('RESOURCE_EXHAUSTED: free_tier_requests quota exceeded'), {
      status: 429
    });
    genaiMocks.generateContent.mockRejectedValue(quotaError);

    const answer = await answerGroupQuestion('今天台南天氣如何？', 'group-1');

    expect(answer).toContain('Gemini API 今日免費額度已用完');
    expect(genaiMocks.generateContent).toHaveBeenCalledTimes(1);
  });
});
