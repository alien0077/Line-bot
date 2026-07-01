import { nanoid } from 'nanoid';
import { config, hasGoogleWorkspaceConfig } from '../config.js';
import { appendSheetRecord, readGroupAliases, readSheetRecords } from './googleWorkspace.js';
import type { ArchiveRecord, ArchiveRecordView, GroupOption, PublicSummary } from '../types.js';
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

function fallbackGroupName(groupId: string): string {
  if (!groupId) return '未知來源';
  if (groupId === 'direct') return '一對一聊天';
  return groupId;
}

function withGroupNames(records: ArchiveRecord[], aliases: Record<string, string>): ArchiveRecordView[] {
  return records.map((record) => ({
    ...record,
    groupName: aliases[record.groupId] || fallbackGroupName(record.groupId)
  }));
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

export async function listGroupAliases(): Promise<Record<string, string>> {
  if (hasGoogleWorkspaceConfig()) {
    return readGroupAliases();
  }
  return { 'demo-group': '示範群組' };
}

export async function listRecordViews(): Promise<ArchiveRecordView[]> {
  const [records, aliases] = await Promise.all([listRecords(), listGroupAliases()]);
  return withGroupNames(records, aliases);
}

export function buildGroupOptions(records: ArchiveRecordView[]): GroupOption[] {
  const groups = new Map<string, GroupOption>();
  for (const record of records) {
    const current = groups.get(record.groupId);
    if (current) {
      current.count += 1;
      if (current.groupName === record.groupId && record.groupName !== record.groupId) {
        current.groupName = record.groupName;
      }
      continue;
    }
    groups.set(record.groupId, {
      groupId: record.groupId,
      groupName: record.groupName,
      count: 1
    });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.groupName.localeCompare(b.groupName));
}

export async function buildPublicSummary(limit: number): Promise<PublicSummary> {
  const records = await listRecordViews();
  const today = startOfToday();
  const week = startOfLast7Days();
  const todayCount = records.filter((record) => Date.parse(record.timestamp) >= today).length;
  const weekCount = records.filter((record) => Date.parse(record.timestamp) >= week).length;
  const typeCounts: Record<string, number> = {};
  const categoryCounts: Record<string, number> = {};
  const groupCounts: Record<string, number> = {};

  for (const record of records) {
    typeCounts[record.messageType] = (typeCounts[record.messageType] ?? 0) + 1;
    categoryCounts[record.category] = (categoryCounts[record.category] ?? 0) + 1;
    groupCounts[record.groupName] = (groupCounts[record.groupName] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    todayCount,
    weekCount,
    typeCounts,
    categoryCounts,
    groupCounts,
    recent: records.slice(0, limit).map((record) => ({
      timestamp: record.timestamp,
      groupId: record.groupId,
      groupName: record.groupName,
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
    analysisMode: config.GEMINI_API_KEY && config.GEMINI_TEXT_ANALYSIS_ENABLED ? 'gemini' : 'local'
  };
}
