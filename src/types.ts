export type MessageType = 'text' | 'image' | 'file' | 'video' | 'audio' | 'sticker' | 'other';

export type MessageCategory =
  | '公告'
  | '待辦'
  | '問題'
  | '檔案'
  | '圖片'
  | '影片'
  | '音訊'
  | '閒聊'
  | '其他';

export interface ArchiveRecord {
  id: string;
  timestamp: string;
  sourceType: string;
  groupId: string;
  userHash: string;
  messageId: string;
  messageType: MessageType;
  content: string;
  category: MessageCategory;
  driveFileId: string;
  driveFileName: string;
  mimeType: string;
  aiSummary: string;
}

export interface ArchiveRecordView extends ArchiveRecord {
  groupName: string;
}

export interface GroupOption {
  groupId: string;
  groupName: string;
  count: number;
}

export interface PublicSummary {
  generatedAt: string;
  todayCount: number;
  weekCount: number;
  typeCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  groupCounts: Record<string, number>;
  recent: Array<Pick<ArchiveRecordView, 'timestamp' | 'groupId' | 'groupName' | 'messageType' | 'category' | 'content' | 'aiSummary' | 'driveFileName'>>;
  summaries: string[];
  storageMode: 'sheets' | 'memory';
  analysisMode: 'gemini' | 'local';
}

export interface AnalysisResult {
  category: MessageCategory;
  summary: string;
}

export interface LineWebhookPayload {
  destination?: string;
  events?: LineWebhookEvent[];
}

export interface LineMentionee {
  index?: number;
  length?: number;
  userId?: string;
  type?: string;
  isSelf?: boolean;
}

export interface LineWebhookEvent {
  type: string;
  timestamp?: number;
  source?: {
    type?: string;
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  message?: {
    id?: string;
    type?: string;
    text?: string;
    fileName?: string;
    fileSize?: number;
    packageId?: string;
    stickerId?: string;
    mention?: {
      mentionees?: LineMentionee[];
    };
  };
  replyToken?: string;
}

export interface MediaUpload {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}
