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
  replyMessages,
  replyText,
  stripMentionText,
  verifyLineSignature
} from '../services/line.js';
import { analyzeText, answerGroupQuestion, classifyTopic } from '../services/gemini.js';
import { uploadMediaToDrive } from '../services/googleWorkspace.js';
import { addRecord, findRecordByMessageId } from '../services/store.js';
import { shortHash } from '../utils/hash.js';
import { HttpError } from '../utils/httpError.js';
import {
  buildCalendarFlexMessage,
  buildGoogleCalendarUrl,
  hasCalendarKeywords,
  parseCalendarEvent
} from '../services/calendar.js';

export const webhookRouter = Router();

const recentRecords = new Map<string, ArchiveRecord>();
const MAX_CACHED_RECORDS = 200;

function cacheRecord(record: ArchiveRecord): void {
  if (recentRecords.size >= MAX_CACHED_RECORDS) {
    const firstKey = recentRecords.keys().next().value;
    if (firstKey) recentRecords.delete(firstKey);
  }
  recentRecords.set(record.messageId, record);
}

function baseCategory(messageType: ArchiveRecord['messageType']): MessageCategory {
  if (messageType === 'image') return '圖片';
  if (messageType === 'file') return '檔案';
  if (messageType === 'video') return '影片';
  if (messageType === 'audio') return '音訊';
  return '其他';
}

function shouldReplyToMention(event: LineWebhookEvent): boolean {
  return Boolean(config.LINE_BOT_QA_ENABLED && event.replyToken && isBotMentioned(event));
}

function shouldUseAiForArchive(event: LineWebhookEvent): boolean {
  if (config.ARCHIVE_AI_MODE === 'all') return true;
  if (config.ARCHIVE_AI_MODE === 'mentions') return isBotMentioned(event);
  return false;
}

async function recordFromEvent(event: LineWebhookEvent): Promise<ArchiveRecord | null> {
  if (event.type !== 'message' || !event.message) return null;

  const messageType = normalizeMessageType(event.message.type);
  const groupId = getEventGroupId(event);
  const messageId = event.message.id ?? nanoid();
  const text = getEventText(event);
  const media = await fetchLineContent(event);
  const drive = media ? await uploadMediaToDrive(groupId, messageId, media) : { fileId: '', fileName: '' };
  const archiveUsesAi = shouldUseAiForArchive(event);
  const analysis = await analyzeText(text, baseCategory(messageType), { forceLocal: !archiveUsesAi });
  const topic = await classifyTopic({
    groupId,
    messageType,
    content: text,
    category: analysis.category,
    driveFileName: drive.fileName,
    mimeType: media?.mimeType ?? '',
    aiSummary: analysis.summary
  }, { forceLocal: !archiveUsesAi });

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

async function tryCalendarReply(replyToken: string, text: string): Promise<boolean> {
  try {
    const calEvent = await parseCalendarEvent(text);
    if (calEvent && calEvent.confidence > 0.5) {
      const url = buildGoogleCalendarUrl(calEvent);
      const flex = buildCalendarFlexMessage(calEvent, url);
      await replyMessages(replyToken, [flex]);
      return true;
    }
  } catch (error) {
    console.warn('日曆解析失敗:', error);
  }
  return false;
}

async function handleMentionReply(event: LineWebhookEvent): Promise<void> {
  if (!shouldReplyToMention(event)) return;
  const replyToken = event.replyToken!;
  const text = stripMentionText(event);
  const groupId = getEventGroupId(event);
  const quotedId = event.message?.quotedMessageId;

  if (config.LINE_CALENDAR_ENABLED) {
    if (quotedId) {
      const original = recentRecords.get(quotedId) ?? await findRecordByMessageId(quotedId);
      if (original?.content && hasCalendarKeywords(original.content)) {
        if (await tryCalendarReply(replyToken, original.content)) return;
      }
    }

    if (hasCalendarKeywords(text)) {
      if (await tryCalendarReply(replyToken, text)) return;
    }
  }

  try {
    const answer = await answerGroupQuestion(text, groupId);
    await replyText(replyToken, answer);
  } catch (error) {
    console.warn('LINE bot QA failed', error);
    try {
      await replyText(replyToken, 'Gemini 現在有點忙，我暫時沒有拿到答案。請稍後再問我一次。');
    } catch (replyError) {
      console.warn('LINE bot QA fallback reply failed', replyError);
    }
  }
}

async function processEventAsync(event: LineWebhookEvent): Promise<void> {
  try {
    const record = await recordFromEvent(event);
    if (!record) return;

    cacheRecord(record);
    await handleMentionReply(event);
    await addRecord(record);
  } catch (error) {
    console.error('背景事件處理失敗:', error);
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

  res.json({
    ok: true,
    received: events.length
  });

  for (const event of events) {
    processEventAsync(event).catch((error) => {
      console.error('背景事件處理失敗:', error);
    });
  }
});
