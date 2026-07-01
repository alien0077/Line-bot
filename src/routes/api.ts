import { Router } from 'express';
import { config } from '../config.js';
import { login, requireAdmin, setSessionCookie } from '../services/auth.js';
import { buildGroupOptions, buildPublicSummary, buildTopicThreads, listRecordViews, storageMode } from '../services/store.js';
import { getDriveMedia } from '../services/googleWorkspace.js';
import { HttpError } from '../utils/httpError.js';

export const apiRouter = Router();

apiRouter.get('/public/summary', async (_req, res) => {
  res.json(await buildPublicSummary(config.PUBLIC_RECENT_LIMIT));
});

apiRouter.post('/admin/login', (req, res) => {
  const password = String(req.body?.password ?? '');
  const token = login(password);
  setSessionCookie(res, token);
  res.json({ ok: true });
});

apiRouter.get('/admin/records', requireAdmin, async (req, res) => {
  const search = String(req.query.search ?? '').trim().toLowerCase();
  const type = String(req.query.type ?? '').trim();
  const groupId = String(req.query.groupId ?? '').trim();
  const topicId = String(req.query.topicId ?? '').trim();
  const pageSize = Math.min(Number(req.query.limit ?? config.ADMIN_PAGE_SIZE), 500);
  const records = await listRecordViews();
  const filtered = records.filter((record) => {
    const typeMatch = !type || record.messageType === type;
    const groupMatch = !groupId || record.groupId === groupId;
    const topicMatch = !topicId || record.topicId === topicId;
    const searchMatch =
      !search ||
      [record.content, record.aiSummary, record.category, record.driveFileName, record.groupId, record.groupName, record.topicTitle, record.topicSummary]
        .join(' ')
        .toLowerCase()
        .includes(search);
    return typeMatch && groupMatch && topicMatch && searchMatch;
  });

  res.json({
    storageMode: storageMode(),
    count: filtered.length,
    groups: buildGroupOptions(records),
    topics: buildTopicThreads(records),
    records: filtered.slice(0, pageSize).map((record) => ({
      ...record,
      mediaProxyUrl: record.driveFileId ? `/api/admin/media/${encodeURIComponent(record.driveFileId)}` : ''
    }))
  });
});

apiRouter.get('/admin/media/:fileId', requireAdmin, async (req, res) => {
  const fileId = String(req.params.fileId ?? '');
  if (!fileId) throw new HttpError(400, '缺少 fileId');
  const media = await getDriveMedia(fileId);
  res.type(media.mimeType);
  media.stream.pipe(res);
});
