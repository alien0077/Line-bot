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
  topicId: string;
  topicTitle: string;
  topicSummary: string;
  topicConfidence: number;
}

export interface ArchiveRecordView extends ArchiveRecord {
  groupName: string;
}

export interface GroupOption {
  groupId: string;
  groupName: string;
  count: number;
}

export interface TopicThread {
  topicId: string;
  topicTitle: string;
  topicSummary: string;
  groupId: string;
  groupName: string;
  count: number;
  firstMessageAt: string;
  lastMessageAt: string;
  categories: Record<string, number>;
  messageTypes: Record<string, number>;
}

export interface PublicSummary {
  generatedAt: string;
  todayCount: number;
  weekCount: number;
  typeCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  groupCounts: Record<string, number>;
  topicCounts: Record<string, number>;
  topics: TopicThread[];
  recent: Array<Pick<ArchiveRecordView, 'timestamp' | 'groupId' | 'groupName' | 'messageType' | 'category' | 'content' | 'aiSummary' | 'driveFileName' | 'topicTitle'>>;
  summaries: string[];
  storageMode: 'sheets' | 'memory';
  analysisMode: 'gemini' | 'local';
}

export interface AnalysisResult {
  category: MessageCategory;
  summary: string;
}

export interface TopicResult {
  topicId: string;
  topicTitle: string;
  topicSummary: string;
  topicConfidence: number;
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
