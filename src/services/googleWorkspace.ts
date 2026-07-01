import { Readable } from 'node:stream';
import { google, type drive_v3, type sheets_v4 } from 'googleapis';
import { config, hasDriveConfig, hasGoogleWorkspaceConfig } from '../config.js';
import type { ArchiveRecord, MediaUpload } from '../types.js';
import { formatDateFolder } from '../utils/dates.js';

const scopes = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file'
];

const header = [
  'id',
  'timestamp',
  'sourceType',
  'groupId',
  'userHash',
  'messageId',
  'messageType',
  'content',
  'category',
  'driveFileId',
  'driveFileName',
  'mimeType',
  'aiSummary',
  'topicId',
  'topicTitle',
  'topicSummary',
  'topicConfidence'
];

const groupHeader = ['groupId', 'displayName', 'notes', 'updatedAt'];

let sheetsClient: sheets_v4.Sheets | null = null;
let driveClient: drive_v3.Drive | null = null;

function parseServiceAccountJson(): Record<string, unknown> | undefined {
  if (!config.GOOGLE_SERVICE_ACCOUNT_JSON) return undefined;
  const raw = config.GOOGLE_SERVICE_ACCOUNT_JSON.trim();
  const decoded = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(decoded) as Record<string, unknown>;
}

async function getAuth() {
  const credentials = parseServiceAccountJson();
  return new google.auth.GoogleAuth({
    credentials,
    keyFile: credentials ? undefined : config.GOOGLE_APPLICATION_CREDENTIALS || undefined,
    scopes
  });
}

async function getSheets(): Promise<sheets_v4.Sheets> {
  if (!sheetsClient) {
    sheetsClient = google.sheets({ version: 'v4', auth: await getAuth() });
  }
  return sheetsClient;
}

async function getDrive(): Promise<drive_v3.Drive> {
  if (!driveClient) {
    driveClient = google.drive({ version: 'v3', auth: await getAuth() });
  }
  return driveClient;
}

function rowFromRecord(record: ArchiveRecord): string[] {
  return header.map((key) => String(record[key as keyof ArchiveRecord] ?? ''));
}

function recordFromRow(row: unknown[]): ArchiveRecord {
  const value = (index: number) => String(row[index] ?? '');
  return {
    id: value(0),
    timestamp: value(1),
    sourceType: value(2),
    groupId: value(3),
    userHash: value(4),
    messageId: value(5),
    messageType: value(6) as ArchiveRecord['messageType'],
    content: value(7),
    category: value(8) as ArchiveRecord['category'],
    driveFileId: value(9),
    driveFileName: value(10),
    mimeType: value(11),
    aiSummary: value(12),
    topicId: value(13),
    topicTitle: value(14),
    topicSummary: value(15),
    topicConfidence: Number(value(16) || 0)
  };
}

async function ensureWorksheet(title: string): Promise<sheets_v4.Sheets> {
  const sheets = await getSheets();
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: config.GOOGLE_SHEETS_SPREADSHEET_ID,
    fields: 'sheets.properties.title'
  });
  const exists = spreadsheet.data.sheets?.some((sheet) => sheet.properties?.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.GOOGLE_SHEETS_SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: { title }
            }
          }
        ]
      }
    });
  }
  return sheets;
}

async function writeHeader(title: string, lastColumn: string, values: string[]): Promise<void> {
  if (!hasGoogleWorkspaceConfig()) return;
  const sheets = await ensureWorksheet(title);
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.GOOGLE_SHEETS_SPREADSHEET_ID,
    range: `${title}!A1:${lastColumn}1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [values]
    }
  });
}

async function ensureSheetHeader(): Promise<void> {
  await writeHeader(config.GOOGLE_SHEETS_SHEET_NAME, 'Q', header);
}

async function ensureGroupsHeader(): Promise<void> {
  await writeHeader(config.GOOGLE_GROUPS_SHEET_NAME, 'D', groupHeader);
}

export async function appendSheetRecord(record: ArchiveRecord): Promise<void> {
  await ensureSheetHeader();
  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.GOOGLE_SHEETS_SPREADSHEET_ID,
    range: `${config.GOOGLE_SHEETS_SHEET_NAME}!A:Q`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [rowFromRecord(record)]
    }
  });
}

export async function readSheetRecords(): Promise<ArchiveRecord[]> {
  await ensureSheetHeader();
  const sheets = await getSheets();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.GOOGLE_SHEETS_SPREADSHEET_ID,
    range: `${config.GOOGLE_SHEETS_SHEET_NAME}!A2:Q10000`
  });
  return (response.data.values ?? []).map(recordFromRow).filter((record) => record.id);
}

export async function readGroupAliases(): Promise<Record<string, string>> {
  if (!hasGoogleWorkspaceConfig()) return {};
  await ensureGroupsHeader();
  const sheets = await getSheets();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.GOOGLE_SHEETS_SPREADSHEET_ID,
    range: `${config.GOOGLE_GROUPS_SHEET_NAME}!A2:D1000`
  });
  const aliases: Record<string, string> = {};
  for (const row of response.data.values ?? []) {
    const groupId = String(row[0] ?? '').trim();
    const displayName = String(row[1] ?? '').trim();
    if (groupId && displayName) aliases[groupId] = displayName;
  }
  return aliases;
}

async function findFolder(name: string, parentId: string): Promise<string | null> {
  const drive = await getDrive();
  const response = await drive.files.list({
    q: [
      `name = '${name.replace(/'/g, "\\'")}'`,
      "mimeType = 'application/vnd.google-apps.folder'",
      `'${parentId}' in parents`,
      'trashed = false'
    ].join(' and '),
    fields: 'files(id, name)',
    pageSize: 1
  });
  return response.data.files?.[0]?.id ?? null;
}

async function ensureFolder(name: string, parentId: string): Promise<string> {
  const existing = await findFolder(name, parentId);
  if (existing) return existing;
  const drive = await getDrive();
  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    },
    fields: 'id'
  });
  if (!response.data.id) throw new Error(`建立 Drive 資料夾失敗：${name}`);
  return response.data.id;
}

export async function uploadMediaToDrive(groupId: string, messageId: string, media: MediaUpload): Promise<{ fileId: string; fileName: string }> {
  if (!hasDriveConfig()) {
    return { fileId: '', fileName: media.fileName };
  }

  const dateFolderId = await ensureFolder(formatDateFolder(), config.GOOGLE_DRIVE_FOLDER_ID);
  const groupFolderId = await ensureFolder(groupId, dateFolderId);
  const drive = await getDrive();
  const fileName = `${messageId}-${media.fileName}`;
  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [groupFolderId]
    },
    media: {
      mimeType: media.mimeType,
      body: Readable.from(media.buffer)
    },
    fields: 'id, name'
  });

  return {
    fileId: response.data.id ?? '',
    fileName: response.data.name ?? fileName
  };
}

export async function getDriveMedia(fileId: string): Promise<{ stream: NodeJS.ReadableStream; mimeType: string }> {
  const drive = await getDrive();
  const metadata = await drive.files.get({
    fileId,
    fields: 'mimeType'
  });
  const media = await drive.files.get(
    {
      fileId,
      alt: 'media'
    },
    { responseType: 'stream' }
  );
  return {
    stream: media.data,
    mimeType: metadata.data.mimeType ?? 'application/octet-stream'
  };
}
