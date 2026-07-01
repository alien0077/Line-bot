import { GoogleGenAI, type GenerateContentConfig } from '@google/genai';
import { config } from '../config.js';
import type { AnalysisResult, ArchiveRecordView, MessageCategory } from '../types.js';
import { listRecordViews } from './store.js';

const categories: MessageCategory[] = ['公告', '待辦', '問題', '檔案', '圖片', '影片', '音訊', '閒聊', '其他'];
const maxLineReplyLength = 1500;
const geminiMaxAttempts = 3;
const transientGeminiStatuses = new Set([429, 500, 502, 503, 504]);
const groupContextKeywords = [
  '群組',
  '群裡',
  '群內',
  '本群',
  '這個群',
  '討論',
  '討論串',
  '聊天紀錄',
  '紀錄',
  '訊息',
  '大家',
  '剛剛',
  '剛才',
  '前面',
  '上面',
  '待辦',
  '誰說',
  '誰提'
];

let dailyKey = '';
let dailyCount = 0;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function localAnalyze(text: string, fallbackCategory: MessageCategory = '其他'): AnalysisResult {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  let category = fallbackCategory;

  if (/請|待辦|todo|deadline|期限|記得|麻煩/.test(lower)) category = '待辦';
  else if (/[?？]|請問|怎麼|如何|為什麼/.test(trimmed)) category = '問題';
  else if (/公告|通知|重要|會議|發布/.test(trimmed)) category = '公告';
  else if (['圖片', '檔案', '影片', '音訊'].includes(fallbackCategory)) category = fallbackCategory;
  else if (trimmed) category = '閒聊';

  return {
    category,
    summary: trimmed ? trimmed.slice(0, 80) : `${category}訊息`
  };
}

function resetCounterIfNeeded(): void {
  const key = todayKey();
  if (key !== dailyKey) {
    dailyKey = key;
    dailyCount = 0;
  }
}

function canUseGemini(): boolean {
  if (!config.GEMINI_API_KEY) return false;
  resetCounterIfNeeded();
  return dailyCount < config.GEMINI_DAILY_LIMIT;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown; code?: unknown }).status ?? (error as { code?: unknown }).code;
  if (typeof status === 'number') return status;
  if (typeof status === 'string') {
    const parsed = Number(status);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isTransientGeminiError(error: unknown): boolean {
  const status = errorStatus(error);
  return Boolean(status && transientGeminiStatuses.has(status));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function generateGeminiText(contents: string, generationConfig: GenerateContentConfig = {}): Promise<string> {
  if (!canUseGemini()) {
    throw new Error('Gemini is not configured or daily limit has been reached');
  }

  dailyCount += 1;
  const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
  let lastError: unknown;

  for (let attempt = 1; attempt <= geminiMaxAttempts; attempt += 1) {
    try {
      const response = await ai.models.generateContent({
        model: config.GEMINI_MODEL,
        contents,
        config: generationConfig
      });
      return response.text ?? '';
    } catch (error) {
      lastError = error;
      if (!isTransientGeminiError(error) || attempt === geminiMaxAttempts) break;
      console.warn(`Gemini transient error, retrying attempt ${attempt + 1}/${geminiMaxAttempts}`, error);
      await sleep(500 * attempt);
    }
  }

  throw lastError;
}

export function getAnalysisMode(): 'gemini' | 'local' {
  return config.GEMINI_API_KEY && config.GEMINI_TEXT_ANALYSIS_ENABLED ? 'gemini' : 'local';
}

export async function analyzeText(text: string, fallbackCategory: MessageCategory = '其他'): Promise<AnalysisResult> {
  if (!config.GEMINI_TEXT_ANALYSIS_ENABLED || !text.trim()) {
    return localAnalyze(text, fallbackCategory);
  }

  if (!canUseGemini()) {
    return localAnalyze(text, fallbackCategory);
  }

  try {
    const raw = (await generateGeminiText(
      `請把以下 LINE 群組訊息分類並摘要。只回 JSON，不要 markdown。JSON 欄位必須是 category 與 summary。分類只能是 ${categories.join('、')}。\n\n訊息：${text}`
    )).replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(raw) as Partial<AnalysisResult>;
    const category = categories.includes(parsed.category as MessageCategory)
      ? (parsed.category as MessageCategory)
      : fallbackCategory;
    return {
      category,
      summary: String(parsed.summary ?? text.slice(0, 80)).slice(0, 160)
    };
  } catch (error) {
    console.warn('Gemini analysis failed, falling back to local analysis', error);
    return localAnalyze(text, fallbackCategory);
  }
}

function extractKeywords(question: string): string[] {
  const normalized = question.toLowerCase();
  const words = normalized.match(/[\p{Script=Han}a-z0-9]{2,}/gu) ?? [];
  return [...new Set(words)].slice(0, 12);
}

function scoreRecord(record: ArchiveRecordView, keywords: string[]): number {
  const haystack = [record.content, record.aiSummary, record.category, record.driveFileName]
    .join(' ')
    .toLowerCase();
  return keywords.reduce((score, keyword) => score + (haystack.includes(keyword) ? 1 : 0), 0);
}

function selectContextRecords(records: ArchiveRecordView[], groupId: string, question: string): ArchiveRecordView[] {
  const groupRecords = records
    .filter((record) => record.groupId === groupId)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const keywords = extractKeywords(question);
  const scored = groupRecords
    .map((record) => ({ record, score: scoreRecord(record, keywords) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.record.timestamp) - Date.parse(a.record.timestamp))
    .map((entry) => entry.record);

  const candidates = scored.length ? scored : groupRecords;
  return candidates.slice(0, Math.max(0, config.LINE_BOT_QA_CONTEXT_LIMIT));
}

function formatContext(records: ArchiveRecordView[]): string {
  if (!records.length) return '沒有可用的同群組歸檔紀錄。';
  return records
    .map((record, index) => {
      const content = record.content || record.driveFileName || record.messageType;
      const summary = record.aiSummary ? `；摘要：${record.aiSummary}` : '';
      return `${index + 1}. ${record.timestamp} [${record.category}/${record.messageType}] ${content}${summary}`;
    })
    .join('\n');
}

function trimLineReply(text: string): string {
  const cleaned = text.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length <= maxLineReplyLength) return cleaned;
  return `${cleaned.slice(0, maxLineReplyLength - 1).trim()}…`;
}

function shouldUseGroupContext(question: string): boolean {
  const normalized = question.toLowerCase();
  return groupContextKeywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function googleSearchConfig(): GenerateContentConfig {
  if (!config.GEMINI_GOOGLE_SEARCH_ENABLED) return {};
  return {
    tools: [{ googleSearch: {} }]
  };
}

function buildGeneralAnswerPrompt(question: string): string {
  return [
    '你是 LINE 群組中的助理。請使用繁體中文回答。',
    '這不是在詢問群組聊天紀錄時，請不要提「群組紀錄不足」。',
    '如果問題涉及今天、日期、天氣、停班停課、假期、新聞、票價、營業時間、政策或其他可能變動的資訊，請以 Google Search grounding 取得的最新資料為準。',
    '如果搜尋結果不足以確認，請明確說無法確認，不要猜。',
    '回答保持精簡、可直接貼在 LINE 群組中。',
    '',
    `使用者問題：${question}`
  ].join('\n');
}

export async function answerGroupQuestion(question: string, groupId: string): Promise<string> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    return '你可以在 @ 我後面直接輸入想問的問題，我會優先參考這個群組的歸檔紀錄回答。';
  }
  if (!config.GEMINI_API_KEY) {
    return '目前尚未設定 Gemini API key，所以我還不能回答問題。';
  }
  if (!canUseGemini()) {
    return '今天的 Gemini 使用量已達上限，晚點再問我會比較穩。';
  }

  if (!shouldUseGroupContext(trimmedQuestion)) {
    const answer = await generateGeminiText(buildGeneralAnswerPrompt(trimmedQuestion), googleSearchConfig());
    return trimLineReply(answer || '我暫時沒有查到可靠答案，請再問一次。');
  }

  const records = await listRecordViews();
  const contextRecords = selectContextRecords(records, groupId, trimmedQuestion);
  const context = formatContext(contextRecords);
  const prompt = [
    '你是 LINE 群組中的助理。請使用繁體中文回答。',
    '回答時優先根據「同群組歸檔紀錄」；如果紀錄不足，請明確說明「群組紀錄裡沒有足夠資訊」，再用一般知識補充。',
    '不要編造群組紀錄中不存在的事實。回答保持精簡、可直接貼在 LINE 群組中。',
    '',
    `使用者問題：${trimmedQuestion}`,
    '',
    '同群組歸檔紀錄：',
    context
  ].join('\n');

  const answer = await generateGeminiText(prompt);
  return trimLineReply(answer || '我暫時沒有產生到回答，請再問一次。');
}
