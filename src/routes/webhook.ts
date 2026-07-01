import { Router } from 'express';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import type { ArchiveRecord, LineWebhookEvent, LineWebhookPayload, MessageCategory } from '../types.js';
import {
  fetchLineContent,
  getEventGroupId,
  getEventText,
  isBotMentioned,
  normalizeMessageType,
  replyText,
  stripMentionText,
  verifyLineSignature
} from '../services/line.js';
import { analyzeText, answerGroupQuestion, classifyTopic } from '../services/gemini.js';
import { uploadMediaToDrive } from '../services/googleWorkspace.js';
import { addRecord } from '../services/store.js';
import { shortHash } from '../utils/hash.js';
import { HttpError } from '../utils/httpError.js';

export const webhookRouter = Router();

function baseCategory(messageType: ArchiveRecord['messageType']): MessageCategory {
  if (messageType === 'image') return '圖片';
  if (messageType === 'file') return '檔案';
  if (messageType === 'video') return '影片';
  if (messageType === 'audio') return '音訊';
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
  const topic = await classifyTopic({
    groupId,
    messageType,
    content: text,
    category: analysis.category,
    driveFileName: drive.fileName,
    mimeType: media?.mimeType ?? '',
    aiSummary: analysis.summary
  });

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
    aiSummary: analysis.summary,
    topicId: topic.topicId,
    topicTitle: topic.topicTitle,
    topicSummary: topic.topicSummary,
    topicConfidence: topic.topicConfidence
  };
}

async function replyToMention(event: LineWebhookEvent): Promise<boolean> {
  if (!config.LINE_BOT_QA_ENABLED || !event.replyToken || !isBotMentioned(event)) return false;

  try {
    const answer = await answerGroupQuestion(stripMentionText(event), getEventGroupId(event));
    await replyText(event.replyToken, answer);
    return true;
  } catch (error) {
    console.warn('LINE bot QA failed', error);
    try {
      await replyText(event.replyToken, 'Gemini 現在有點忙，我已經重試過但還是沒拿到答案。請稍後再問我一次。');
      return true;
    } catch (replyError) {
      console.warn('LINE bot QA fallback reply failed', replyError);
      return false;
    }
  }
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
  let replied = 0;

  for (const event of events) {
    const record = await recordFromEvent(event);
    if (!record) continue;
    await addRecord(record);
    stored.push(record.id);
    if (await replyToMention(event)) replied += 1;
  }

  res.json({
    ok: true,
    received: events.length,
    stored: stored.length,
    replied,
    ids: stored
  });
});
