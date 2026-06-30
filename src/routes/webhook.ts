import { Router } from 'express';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import type { ArchiveRecord, LineWebhookEvent, LineWebhookPayload, MessageCategory } from '../types.js';
import { fetchLineContent, getEventGroupId, getEventText, normalizeMessageType, verifyLineSignature } from '../services/line.js';
import { analyzeText } from '../services/gemini.js';
import { uploadMediaToDrive } from '../services/googleWorkspace.js';
import { addRecord } from '../services/store.js';
import { shortHash } from '../utils/hash.js';
import { HttpError } from '../utils/httpError.js';

export const webhookRouter = Router();

function baseCategory(messageType: ArchiveRecord['messageType']): MessageCategory {
  if (messageType === 'image') return '圖片';
  if (messageType === 'file') return '檔案';
  return '其他';
}

async function recordFromEvent(event: LineWebhookEvent): Promise<ArchiveRecord | null> {
  if (event.type !== 'message' || !event.message) return null;

  const messageType = normalizeMessageType(event.message.type);
  const groupId = getEventGroupId(event);
  const messageId = event.message.id ?? nanoid();
  const text = getEventText(event);
  const media = await fetchLineContent(event);
  const drive = media ? await uploadMediaToDrive(groupId, messageId, media) : { fileId: '', fileName: '' };
  const analysis = await analyzeText(text, baseCategory(messageType));

  return {
    id: nanoid(),
    timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
    sourceType: event.source?.type ?? 'unknown',
    groupId,
    userHash: shortHash(`${config.USER_HASH_SALT}:${event.source?.userId ?? 'unknown-user'}`),
    messageId,
    messageType,
    content: text,
    category: analysis.category,
    driveFileId: drive.fileId,
    driveFileName: drive.fileName,
    mimeType: media?.mimeType ?? '',
    aiSummary: analysis.summary
  };
}

webhookRouter.post('/line', async (req, res) => {
  const signature = req.header('x-line-signature') ?? '';
  const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body ?? {}));

  if (!verifyLineSignature(rawBody, signature)) {
    throw new HttpError(401, 'LINE Webhook 簽章驗證失敗');
  }

  const payload = req.body as LineWebhookPayload;
  const events = payload.events ?? [];
  const stored: string[] = [];

  for (const event of events) {
    const record = await recordFromEvent(event);
    if (!record) continue;
    await addRecord(record);
    stored.push(record.id);
  }

  res.json({
    ok: true,
    received: events.length,
    stored: stored.length,
    ids: stored
  });
});
