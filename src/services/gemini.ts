import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import type { AnalysisResult, MessageCategory } from '../types.js';

const categories: MessageCategory[] = ['公告', '待辦', '問題', '檔案', '圖片', '影片', '音訊', '閒聊', '其他'];

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

export function getAnalysisMode(): 'gemini' | 'local' {
  return config.GEMINI_API_KEY && config.GEMINI_TEXT_ANALYSIS_ENABLED ? 'gemini' : 'local';
}

export async function analyzeText(text: string, fallbackCategory: MessageCategory = '其他'): Promise<AnalysisResult> {
  if (!config.GEMINI_API_KEY || !config.GEMINI_TEXT_ANALYSIS_ENABLED || !text.trim()) {
    return localAnalyze(text, fallbackCategory);
  }

  resetCounterIfNeeded();
  if (dailyCount >= config.GEMINI_DAILY_LIMIT) {
    return localAnalyze(text, fallbackCategory);
  }

  try {
    dailyCount += 1;
    const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: config.GEMINI_MODEL,
      contents: `請把以下 LINE 群組訊息分類並摘要。只回 JSON，不要 markdown。JSON 欄位必須是 category 與 summary。分類只能是 ${categories.join('、')}。\n\n訊息：${text}`
    });
    const raw = (response.text ?? '').replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
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
