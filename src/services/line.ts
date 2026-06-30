import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import type { LineWebhookEvent, MediaUpload, MessageType } from '../types.js';
import { HttpError } from '../utils/httpError.js';
import { safeEqual } from '../utils/hash.js';

const contentApiBaseUrl = 'https://api-data.line.me/v2/bot/message';

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

function extensionFromMime(mimeType: string): string {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('gif')) return 'gif';
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
