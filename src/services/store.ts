import { nanoid } from 'nanoid';
import { hasGoogleWorkspaceConfig } from '../config.js';
import { appendSheetRecord, readSheetRecords } from './googleWorkspace.js';
import { getAnalysisMode } from './gemini.js';
import type { ArchiveRecord, PublicSummary } from '../types.js';
import { startOfLast7Days, startOfToday } from '../utils/dates.js';

const memoryRecords: ArchiveRecord[] = [
  {
    id: nanoid(),
    timestamp: new Date().toISOString(),
    sourceType: 'demo',
    groupId: 'demo-group',
    userHash: 'demo-user',
    messageId: 'demo-message',
    messageType: 'text',
    content: '這是一筆本機示範訊息。填入 LINE、Google、Gemini 設定後，這裡會改成真實群組資料。',
    category: '公告',
    driveFileId: '',
    driveFileName: '',
    mimeType: '',
    aiSummary: '本機示範資料，方便先確認儀表板可以正常顯示。'
  }
];

export function storageMode(): 'sheets' | 'memory' {
  return hasGoogleWorkspaceConfig() ? 'sheets' : 'memory';
}

export async function addRecord(record: ArchiveRecord): Promise<void> {
  if (hasGoogleWorkspaceConfig()) {
    await appendSheetRecord(record);
    return;
  }
  memoryRecords.unshift(record);
}

export async function listRecords(): Promise<ArchiveRecord[]> {
  if (hasGoogleWorkspaceConfig()) {
    const records = await readSheetRecords();
    return records.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  }
  return [...memoryRecords];
}

export async function buildPublicSummary(limit: number): Promise<PublicSummary> {
  const records = await listRecords();
  const today = startOfToday();
  const week = startOfLast7Days();
  const todayCount = records.filter((record) => Date.parse(record.timestamp) >= today).length;
  const weekCount = records.filter((record) => Date.parse(record.timestamp) >= week).length;
  const typeCounts: Record<string, number> = {};
  const categoryCounts: Record<string, number> = {};

  for (const record of records) {
    typeCounts[record.messageType] = (typeCounts[record.messageType] ?? 0) + 1;
    categoryCounts[record.category] = (categoryCounts[record.category] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    todayCount,
    weekCount,
    typeCounts,
    categoryCounts,
    recent: records.slice(0, limit).map((record) => ({
      timestamp: record.timestamp,
      messageType: record.messageType,
      category: record.category,
      content: record.content ? `${record.content.slice(0, 48)}${record.content.length > 48 ? '...' : ''}` : '',
      aiSummary: record.aiSummary,
      driveFileName: record.driveFileName
    })),
    summaries: records
      .map((record) => record.aiSummary)
      .filter(Boolean)
      .slice(0, 5),
    storageMode: storageMode(),
    analysisMode: getAnalysisMode()
  };
}
