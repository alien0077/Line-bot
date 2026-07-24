import { config } from '../config.js';
import type { ParsedCalendarEvent } from '../types.js';
import { generateGeminiText } from './gemini.js';

function currentTaipeiISO(): string {
  const now = new Date();
  const taipei = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(now);
  const get = (t: string) => taipei.find(p => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+08:00`;
}

function toCalendarDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export async function parseCalendarEvent(text: string): Promise<ParsedCalendarEvent | null> {
  if (!text.trim()) return null;

  const prompt = `現在時間是 ${currentTaipeiISO()}（時區：Asia/Taipei）。

從以下文字中提取行程資訊。
- 以現在時間為基準推算相對時間（如「明天」= 現在 +1天）
- 如果文字不含明確的事件或時間，請設 confidence 為 0
- 若未指定結束時間，預設為開始後 1 小時
- 若未指定地點，location 設為空字串

只回 JSON，不要 markdown 包裝：

{
  "title": "事件名稱",
  "startTime": "ISO 8601 完整時間字串",
  "endTime": "ISO 8601 完整時間字串",
  "location": "地點或空字串",
  "description": "完整原始描述",
  "confidence": 0.0-1.0
}

文字：${text}`;

  try {
    const raw = await generateGeminiText(prompt, {
      temperature: 0.1,
      responseMimeType: 'application/json'
    });
    const parsed = JSON.parse(raw) as Partial<ParsedCalendarEvent>;
    if (typeof parsed.confidence !== 'number' || parsed.confidence <= 0) return null;
    if (!parsed.title || !parsed.startTime) return null;
    return {
      title: parsed.title.slice(0, 100),
      startTime: parsed.startTime,
      endTime: parsed.endTime || parsed.startTime,
      location: parsed.location ?? '',
      description: parsed.description?.slice(0, 500) ?? '',
      confidence: Math.max(0, Math.min(1, parsed.confidence))
    };
  } catch (error) {
    console.warn('日曆解析失敗:', error);
    return null;
  }
}

export function buildGoogleCalendarUrl(event: ParsedCalendarEvent): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${toCalendarDate(event.startTime)}Z/${toCalendarDate(event.endTime)}Z`,
    ctz: 'Asia/Taipei'
  });
  if (event.location) params.set('location', event.location);
  if (event.description) params.set('details', event.description);
  return `https://www.google.com/calendar/render?${params.toString()}`;
}

export function buildCalendarFlexMessage(event: ParsedCalendarEvent, url: string): object {
  const timeStr = formatTimeRange(event.startTime, event.endTime);
  const bodyContents: object[] = [
    {
      type: 'text',
      text: event.title,
      weight: 'bold',
      size: 'xl',
      wrap: true
    },
    {
      type: 'separator',
      margin: 'md'
    },
    {
      type: 'box',
      layout: 'baseline',
      spacing: 'sm',
      contents: [
        { type: 'text', text: '🕐', flex: 0, size: 'md' },
        { type: 'text', text: timeStr, wrap: true, flex: 1, size: 'md' }
      ]
    }
  ];

  if (event.location) {
    bodyContents.push({
      type: 'box',
      layout: 'baseline',
      spacing: 'sm',
      contents: [
        { type: 'text', text: '📍', flex: 0, size: 'md' },
        { type: 'text', text: event.location, wrap: true, flex: 1, size: 'md' }
      ]
    });
  }

  if (event.description) {
    bodyContents.push({
      type: 'box',
      layout: 'baseline',
      spacing: 'sm',
      contents: [
        { type: 'text', text: '📝', flex: 0, size: 'md' },
        { type: 'text', text: event.description, wrap: true, flex: 1, size: 'sm', color: '#666666' }
      ]
    });
  }

  return {
    type: 'flex',
    altText: `📅 ${event.title}`,
    contents: {
      type: 'bubble',
      size: 'giga',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: bodyContents
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#4285F4',
            action: {
              type: 'uri',
              label: '📅 加到我的 Google 日曆',
              uri: url
            }
          }
        ]
      }
    }
  };
}

function formatTimeRange(startISO: string, endISO: string): string {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const taipei = new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric', month: 'long', day: 'numeric',
      weekday: 'short',
      hour: '2-digit', minute: '2-digit',
      hour12: false
    });
    return taipei.format(d);
  };
  return `${fmt(startISO)} — ${fmt(endISO)}`;
}

const calendarKeywords = [
  '明天', '今天', '後天', '大後天',
  '週一', '週二', '週三', '週四', '週五', '週六', '週日', '週末',
  '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日',
  '下週', '這週', '上週', '下個月', '這個月',
  '幾點', '幾時',
  '行程', '日曆', '約', '開會', '會議', '聚餐', '吃飯', '見面', '聚會',
];

export function hasCalendarKeywords(text: string): boolean {
  return calendarKeywords.some(keyword => text.includes(keyword));
}
