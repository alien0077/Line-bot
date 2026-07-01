import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import type { LineWebhookEvent, MediaUpload, MessageType } from '../types.js';
import { HttpError } from '../utils/httpError.js';
import { safeEqual } from '../utils/hash.js';

const contentApiBaseUrl = 'https://api-data.line.me/v2/bot/message';
const messagingApiBaseUrl = 'https://api.line.me/v2/bot/message';

export function verifyLineSignature(rawBody: Buffer, signature = ''): boolean {
  if (!config.LINE_CHANNEL_SECRET) {
    return config.ALLOW_UNSIGNED_WEBHOOKS && config.NODE_ENV !== 'production';
  }
  const digest = createHmac('sha256', config.LINE_CHANNEL_SECRET).update(rawBody).digest('base64');
  return safeEqual(signature, digest);
}

export function normalizeMessageType(type?: string): MessageType {
  if (type === 'text' || type === 'image' || type === 'file' || type === 'video' || type === 'audio' || type === 'sticker') {
    return type;
  }
  return 'other';
}

export function getEventGroupId(event: LineWebhookEvent): string {
  return event.source?.groupId ?? event.source?.roomId ?? event.source?.userId ?? 'unknown-source';
}

export function getEventText(event: LineWebhookEvent): string {
  const message = event.message;
  if (!message) return '';
  if (message.type === 'text') return message.text ?? '';
  if (message.type === 'file') return message.fileName ?? '未命名檔案';
  if (message.type === 'sticker') return `貼圖 ${message.packageId ?? ''}/${message.stickerId ?? ''}`.trim();
  return normalizeMessageType(message.type);
}

export function isBotMentioned(event: LineWebhookEvent): boolean {
  if (event.type !== 'message' || event.message?.type !== 'text') return false;
  return event.message.mention?.mentionees?.some((mentionee) => mentionee.isSelf === true) ?? false;
}

export function stripMentionText(event: LineWebhookEvent): string {
  const text = event.message?.text ?? '';
  const mentionees = [...(event.message?.mention?.mentionees ?? [])]
    .filter((mentionee) => mentionee.isSelf === true && typeof mentionee.index === 'number' && typeof mentionee.length === 'number')
    .sort((a, b) => (b.index ?? 0) - (a.index ?? 0));

  let stripped = text;
  for (const mentionee of mentionees) {
    const start = mentionee.index ?? 0;
    const end = start + (mentionee.length ?? 0);
    stripped = `${stripped.slice(0, start)}${stripped.slice(end)}`;
  }
  return stripped.replace(/\s+/g, ' ').trim();
}

function extensionFromMime(mimeType: string): string {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('gif')) return 'gif';
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('quicktime')) return 'mov';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('pdf')) return 'pdf';
  return 'bin';
}

export async function fetchLineContent(event: LineWebhookEvent): Promise<MediaUpload | null> {
  const message = event.message;
  if (!message?.id) return null;
  const messageType = normalizeMessageType(message.type);
  if (!['image', 'file', 'video', 'audio'].includes(messageType)) return null;
  if (!config.LINE_CHANNEL_ACCESS_TOKEN) {
    throw new HttpError(503, '尚未設定 LINE_CHANNEL_ACCESS_TOKEN，無法下載媒體內容');
  }

  const response = await fetch(`${contentApiBaseUrl}/${message.id}/content`, {
    headers: {
      Authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}`
    }
  });
  if (!response.ok) {
    throw new HttpError(response.status, `LINE 內容下載失敗：${response.statusText}`);
  }

  const mimeType = response.headers.get('content-type') ?? 'application/octet-stream';
  const arrayBuffer = await response.arrayBuffer();
  const fileName = message.fileName || `${message.id}.${extensionFromMime(mimeType)}`;
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType,
    fileName
  };
}

export async function replyText(replyToken: string, text: string): Promise<void> {
  if (!config.LINE_CHANNEL_ACCESS_TOKEN) {
    throw new HttpError(503, '尚未設定 LINE_CHANNEL_ACCESS_TOKEN，無法回覆 LINE 訊息');
  }

  const response = await fetch(`${messagingApiBaseUrl}/reply`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      replyToken,
      messages: [
        {
          type: 'text',
          text: text.slice(0, 5000)
        }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new HttpError(response.status, `LINE 回覆失敗：${response.statusText}${body ? ` ${body}` : ''}`);
  }
}
