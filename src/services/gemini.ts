import { GoogleGenAI, type GenerateContentConfig } from '@google/genai';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import type { AnalysisResult, ArchiveRecord, ArchiveRecordView, MessageCategory, TopicResult } from '../types.js';
import { listRecordViews } from './store.js';

const categories: MessageCategory[] = ['公告', '待辦', '問題', '檔案', '圖片', '影片', '音訊', '閒聊', '其他'];
const maxLineReplyLength = 1500;
const geminiMaxAttempts = 3;
const topicCandidateLimit = 12;
const transientGeminiStatuses = new Set([500, 502, 503, 504]);
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
let quotaBlockedUntil = 0;

type GeminiCallOptions = {
  forceLocal?: boolean;
};

type AiProvider = 'gemini' | 'openrouter' | 'nvidia';

type AiGenerateOptions = {
  geminiConfig?: GenerateContentConfig;
  openRouterWebSearch?: boolean;
};

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

const topicStopwords = new Set([
  '請問',
  '怎麼',
  '如何',
  '為什麼',
  '可以',
  '可否',
  '是不是',
  '是否',
  '今天',
  '明天',
  '昨天',
  '剛剛',
  '剛才',
  '這個',
  '那個',
  '大家',
  '有人',
  '什麼',
  '一下',
  '幫我',
  '幫忙',
  '麻煩',
  '謝謝',
  '我們',
  '你們',
  '他們',
  '這週',
  '這周',
  '這裡',
  '群組',
  '本群'
]);

function addScore(scores: Partial<Record<MessageCategory, number>>, category: MessageCategory, score: number): void {
  scores[category] = (scores[category] ?? 0) + score;
}

function localAnalyze(text: string, fallbackCategory: MessageCategory = '其他'): AnalysisResult {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const scores: Partial<Record<MessageCategory, number>> = {};

  if (['圖片', '檔案', '影片', '音訊'].includes(fallbackCategory)) addScore(scores, fallbackCategory, 5);
  if (/公告|通知|重要|宣布|發布|異動|停班|停課|更新/.test(trimmed)) addScore(scores, '公告', 4);
  if (/會議|開會|集合|報名|活動|課程|行程|時間|地點/.test(trimmed)) addScore(scores, '公告', 2);
  if (/待辦|todo|deadline|期限|記得|提醒|追蹤|處理|完成|繳交|回覆/.test(lower)) addScore(scores, '待辦', 4);
  if (/麻煩|幫忙|協助|請大家|請記得|請協助|請幫/.test(trimmed)) addScore(scores, '待辦', 2);
  if (/[?？]|請問|怎麼|如何|為什麼|哪裡|哪個|何時|幾點|是否|可否|嗎/.test(trimmed)) addScore(scores, '問題', 5);
  if (/http:\/\/|https:\/\//i.test(trimmed)) addScore(scores, trimmed.length < 120 ? '其他' : '閒聊', 2);
  if (!trimmed) addScore(scores, fallbackCategory, 1);
  if (trimmed && !Object.keys(scores).length) addScore(scores, '閒聊', 1);

  const category = (Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key)[0] as MessageCategory | undefined) ?? fallbackCategory;

  return {
    category,
    summary: trimmed ? trimmed.slice(0, 80) : `${category}訊息`
  };
}

function normalizeTopicText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@\S+/g, ' ')
    .replace(/[「」『』()[\]{}<>,，。！？?！:：;；/\\|"'`~*_+=#$%^&\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function topicTokens(record: Pick<ArchiveRecord, 'category' | 'content' | 'driveFileName' | 'messageType' | 'aiSummary'>): string[] {
  const source = normalizeTopicText([record.content, record.aiSummary, record.driveFileName].filter(Boolean).join(' '));
  if (!source && record.driveFileName) return [record.driveFileName.replace(/\.[^.]+$/, '').slice(0, 12)];
  if (/https?:\/\//i.test(record.content || '')) return ['連結分享'];

  const rawTokens = source.match(/[\p{Script=Han}a-zA-Z0-9]{2,}/gu) ?? [];
  const tokens = rawTokens
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !topicStopwords.has(token))
    .filter((token) => !/^\d+$/.test(token));

  const compactChinese = source.replace(/[^\p{Script=Han}]/gu, '');
  if (compactChinese.length >= 4) {
    for (const phrase of compactChinese.match(/[\p{Script=Han}]{4,8}/gu) ?? []) {
      if (!topicStopwords.has(phrase)) tokens.unshift(phrase);
    }
  }

  return [...new Set(tokens)].slice(0, 3);
}

function topicTitleFromTokens(record: Pick<ArchiveRecord, 'category' | 'content' | 'driveFileName' | 'messageType' | 'aiSummary'>, tokens: string[]): string {
  if (tokens.length) {
    const title = tokens.join('、').slice(0, 16);
    if (record.category !== '閒聊' || title.length >= 3) return title;
  }
  if (record.messageType === 'sticker') return '貼圖訊息';
  if (record.category === '圖片' && record.driveFileName) return '圖片分享';
  if (record.category === '檔案' && record.driveFileName) return '檔案分享';
  return record.category || '未分類主題';
}

function topicSlug(groupId: string, title: string): string {
  const normalized = title.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, '-').replace(/^-|-$/g, '');
  return `local-${groupId}-${normalized || title}`;
}

function localTopic(record: Pick<ArchiveRecord, 'groupId' | 'category' | 'content' | 'driveFileName' | 'messageType' | 'aiSummary'>): TopicResult {
  const tokens = topicTokens(record);
  const title = topicTitleFromTokens(record, tokens);
  return {
    topicId: topicSlug(record.groupId, title),
    topicTitle: title,
    topicSummary: record.aiSummary || record.content || record.driveFileName || `${title}相關${record.messageType}訊息`,
    topicConfidence: tokens.length ? 0.55 : 0.35
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
  if (Date.now() < quotaBlockedUntil) return false;
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

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isGeminiQuotaError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === 429) return true;
  return /RESOURCE_EXHAUSTED|quota|free_tier_requests|rate limit/i.test(errorText(error));
}

function blockGeminiUntilNextUtcDay(): void {
  const nextDay = new Date();
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  nextDay.setUTCHours(0, 0, 0, 0);
  quotaBlockedUntil = Math.max(quotaBlockedUntil, nextDay.getTime());
}

function geminiLimitMessage(): string {
  return '目前 AI 供應商暫時無法產生回答。Gemini 今日免費額度可能已用完，備援模型也沒有成功回應，請稍後再問我一次。';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function cleanJson(raw: string): string {
  return raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
}

function clampConfidence(value: unknown): number {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return 0;
  return Math.max(0, Math.min(1, confidence));
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
      if (isGeminiQuotaError(error)) {
        blockGeminiUntilNextUtcDay();
        break;
      }
      if (!isTransientGeminiError(error) || attempt === geminiMaxAttempts) break;
      console.warn(`Gemini transient error, retrying attempt ${attempt + 1}/${geminiMaxAttempts}`, error);
      await sleep(500 * attempt);
    }
  }

  throw lastError;
}

function normalizeProvider(value: string): AiProvider | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'gemini' || normalized === 'openrouter' || normalized === 'nvidia') return normalized;
  return undefined;
}

function configuredProviderOrder(): AiProvider[] {
  const order: AiProvider[] = [];
  const primary = normalizeProvider(config.AI_PROVIDER) ?? 'gemini';
  const fallbacks = config.AI_FALLBACK_PROVIDERS
    .split(/[,;\s]+/)
    .map((provider) => normalizeProvider(provider))
    .filter((provider): provider is AiProvider => Boolean(provider));

  for (const provider of [primary, ...fallbacks]) {
    if (!order.includes(provider)) order.push(provider);
  }
  return order;
}

function canUseProvider(provider: AiProvider): boolean {
  if (provider === 'gemini') return canUseGemini();
  if (provider === 'openrouter') return Boolean(config.OPENROUTER_API_KEY);
  return Boolean(config.NVIDIA_API_KEY);
}

function hasAnswerProvider(): boolean {
  return configuredProviderOrder().some((provider) => canUseProvider(provider));
}

function makeHttpError(provider: AiProvider, status: number, body: string): Error & { status: number; provider: AiProvider } {
  const error = new Error(`${provider} API failed with ${status}: ${body.slice(0, 500)}`) as Error & {
    status: number;
    provider: AiProvider;
  };
  error.status = status;
  error.provider = provider;
  return error;
}

async function readChatCompletionResponse(provider: AiProvider, response: Response): Promise<string> {
  const bodyText = await response.text();
  if (!response.ok) throw makeHttpError(provider, response.status, bodyText);
  const parsed = JSON.parse(bodyText) as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
  };
  const content = parsed.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

async function generateOpenRouterText(contents: string, options: AiGenerateOptions = {}): Promise<string> {
  const plugins = options.openRouterWebSearch && config.OPENROUTER_WEB_SEARCH_ENABLED
    ? [{ id: 'web' }]
    : undefined;
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': config.APP_BASE_URL,
      'X-OpenRouter-Title': 'LINE Group Archive Bot'
    },
    body: JSON.stringify({
      model: config.OPENROUTER_MODEL,
      messages: [{ role: 'user', content: contents }],
      max_tokens: 900,
      temperature: 0.3,
      plugins
    })
  });
  return readChatCompletionResponse('openrouter', response);
}

async function generateNvidiaText(contents: string): Promise<string> {
  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.NVIDIA_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.NVIDIA_MODEL,
      messages: [{ role: 'user', content: contents }],
      max_tokens: 900,
      temperature: 0.3
    })
  });
  return readChatCompletionResponse('nvidia', response);
}

async function generateAnswerText(contents: string, options: AiGenerateOptions = {}): Promise<string> {
  let lastError: unknown;
  for (const provider of configuredProviderOrder()) {
    if (!canUseProvider(provider)) continue;
    try {
      if (provider === 'gemini') return await generateGeminiText(contents, options.geminiConfig ?? {});
      if (provider === 'openrouter') return await generateOpenRouterText(contents, options);
      return await generateNvidiaText(contents);
    } catch (error) {
      lastError = error;
      if (provider === 'gemini' && isGeminiQuotaError(error)) {
        blockGeminiUntilNextUtcDay();
      }
      console.warn(`${provider} answer generation failed, trying next provider`, error);
    }
  }
  throw lastError ?? new Error('No AI provider is configured for answering');
}

export function getAnalysisMode(): 'gemini' | 'local' {
  return config.ARCHIVE_AI_MODE !== 'local' && config.GEMINI_API_KEY && config.GEMINI_TEXT_ANALYSIS_ENABLED ? 'gemini' : 'local';
}

export async function analyzeText(
  text: string,
  fallbackCategory: MessageCategory = '其他',
  options: GeminiCallOptions = {}
): Promise<AnalysisResult> {
  if (options.forceLocal || !config.GEMINI_TEXT_ANALYSIS_ENABLED || !text.trim()) {
    return localAnalyze(text, fallbackCategory);
  }

  if (!canUseGemini()) {
    return localAnalyze(text, fallbackCategory);
  }

  try {
    const raw = cleanJson(await generateGeminiText(
      `請把以下 LINE 群組訊息分類並摘要。只回 JSON，不要 markdown。JSON 欄位必須是 category 與 summary。分類只能是 ${categories.join('、')}。\n\n訊息：${text}`
    ));
    const parsed = JSON.parse(raw) as Partial<AnalysisResult>;
    const category = categories.includes(parsed.category as MessageCategory)
      ? (parsed.category as MessageCategory)
      : fallbackCategory;
    return {
      category,
      summary: String(parsed.summary ?? text.slice(0, 80)).slice(0, 160)
    };
  } catch (error) {
    if (isGeminiQuotaError(error)) {
      blockGeminiUntilNextUtcDay();
    }
    console.warn('Gemini analysis failed, falling back to local analysis', error);
    return localAnalyze(text, fallbackCategory);
  }
}

function topicCandidates(records: ArchiveRecordView[], groupId: string): ArchiveRecordView[] {
  const latestByTopic = new Map<string, ArchiveRecordView>();
  for (const record of records) {
    if (record.groupId !== groupId || !record.topicId) continue;
    const existing = latestByTopic.get(record.topicId);
    if (!existing || Date.parse(record.timestamp) > Date.parse(existing.timestamp)) {
      latestByTopic.set(record.topicId, record);
    }
  }
  return [...latestByTopic.values()]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, topicCandidateLimit);
}

function formatTopicCandidates(candidates: ArchiveRecordView[]): string {
  if (!candidates.length) return '目前沒有既有主題。';
  return candidates
    .map((record, index) => {
      return `${index + 1}. topicId=${record.topicId}; title=${record.topicTitle}; summary=${record.topicSummary || record.aiSummary}; lastMessageAt=${record.timestamp}`;
    })
    .join('\n');
}

function buildTopicPrompt(record: Pick<ArchiveRecord, 'groupId' | 'messageType' | 'content' | 'category' | 'driveFileName' | 'mimeType' | 'aiSummary'>, candidates: ArchiveRecordView[]): string {
  return [
    '你是 LINE 群組訊息歸檔系統的主題分類器。請判斷新訊息應該延續哪個既有主題，或建立新主題。',
    '只回 JSON，不要 markdown。JSON 欄位：topicId、topicTitle、topicSummary、topicConfidence。',
    '如果新訊息和既有主題是同一件事、同一活動、同一問題的後續，就沿用既有 topicId。',
    '如果只是同一大類但不是同一討論串，請建立新主題，topicId 留空字串。',
    '圖片、影片、音訊、檔案需依檔名、訊息類型、AI 摘要與最近主題判斷；不確定時建立新主題。',
    'topicTitle 請用 4 到 16 個繁體中文字，適合放在 dashboard。',
    'topicSummary 請用一句繁體中文摘要目前主題。',
    'topicConfidence 是 0 到 1 的數字。',
    '',
    '既有主題：',
    formatTopicCandidates(candidates),
    '',
    '新訊息：',
    `groupId=${record.groupId}`,
    `messageType=${record.messageType}`,
    `category=${record.category}`,
    `content=${record.content || '(非文字訊息)'}`,
    `driveFileName=${record.driveFileName || ''}`,
    `mimeType=${record.mimeType || ''}`,
    `aiSummary=${record.aiSummary || ''}`
  ].join('\n');
}

export async function classifyTopic(
  record: Pick<ArchiveRecord, 'groupId' | 'messageType' | 'content' | 'category' | 'driveFileName' | 'mimeType' | 'aiSummary'>,
  options: GeminiCallOptions = {}
): Promise<TopicResult> {
  if (options.forceLocal || !canUseGemini()) {
    return localTopic(record);
  }

  try {
    const records = await listRecordViews();
    const candidates = topicCandidates(records, record.groupId);
    const candidateIds = new Set(candidates.map((candidate) => candidate.topicId));
    const raw = cleanJson(await generateGeminiText(buildTopicPrompt(record, candidates)));
    const parsed = JSON.parse(raw) as Partial<TopicResult>;
    const topicId = String(parsed.topicId ?? '').trim();
    const selected = topicId && candidateIds.has(topicId)
      ? candidates.find((candidate) => candidate.topicId === topicId)
      : undefined;
    const title = String(parsed.topicTitle || selected?.topicTitle || record.category || '未分類主題').trim().slice(0, 32);
    const summary = String(parsed.topicSummary || selected?.topicSummary || record.aiSummary || record.content || record.driveFileName || title).trim().slice(0, 180);
    return {
      topicId: selected?.topicId || `topic-${nanoid(10)}`,
      topicTitle: title,
      topicSummary: summary,
      topicConfidence: clampConfidence(parsed.topicConfidence)
    };
  } catch (error) {
    if (isGeminiQuotaError(error)) {
      blockGeminiUntilNextUtcDay();
    }
    console.warn('Gemini topic classification failed, falling back to local topic', error);
    return localTopic(record);
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
  if (!hasAnswerProvider()) {
    return '目前尚未設定可用的 AI provider，所以我還不能回答問題。';
  }

  try {
    if (!shouldUseGroupContext(trimmedQuestion)) {
      const answer = await generateAnswerText(buildGeneralAnswerPrompt(trimmedQuestion), {
        geminiConfig: googleSearchConfig(),
        openRouterWebSearch: true
      });
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

    const answer = await generateAnswerText(prompt);
    return trimLineReply(answer || '我暫時沒有產生到回答，請再問一次。');
  } catch (error) {
    if (isGeminiQuotaError(error)) {
      blockGeminiUntilNextUtcDay();
      return geminiLimitMessage();
    }
    throw error;
  }
}
