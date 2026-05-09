export interface FeishuConnectionConfig {
  appId: string;
  appSecret: string;
}

// ==================== NEW: 结构化 Mention 信息 ====================

/** 消息中的 @提及 信息 */
export interface MentionInfo {
  /** 被 @ 用户的 open_id */
  userId: string;
  /** 被 @ 用户的显示名称 */
  name: string;
  /** 是否是 @了 bot 自己 */
  isSelf: boolean;
}

export interface FeishuMessage {
  messageId: string;       // IMPORTANT: used as reply target for im.message.reply
  chatId: string;
  threadId?: string;       // NEW: thread ID, only present for thread/topic group messages
  senderId: string;
  senderName: string;
  content: string;
  messageType: string;
  timestamp: string;
  attachments?: string;    // JSON string of attachment data

  // ==================== NEW: @ 提及列表 ====================

  /** 消息中的 @提及 列表（结构化，供下游代码消费） */
  mentions?: MentionInfo[];

  // ==================== NEW: 引用消息 & 文件附件 ====================

  /** 被引用/回复的原始消息 ID（来自事件的 parent_id 或 upper_message_id） */
  parentId?: string;

  /** 被引用消息的文本内容（由 bridge 层异步填充） */
  quotedContent?: string;

  /** 消息中包含的图片 key 列表 */
  imageKeys?: string[];

  /** 消息中包含的文件 key 列表 */
  fileKeys?: string[];

  /** 下载到本地后的文件路径列表（由 bridge 层填充） */
  downloadedPaths?: string[];

  /**
   * 发信人邮箱前缀(e.g. xxx@bytedance.com → xxx),由 IdentityResolver 解析填充。
   * 用于 Langfuse 等监控系统按 user 维度聚合,缺失时回退到 senderId。
   */
  senderEmailPrefix?: string;
}

export interface ThreadContext {
  threadId: string;
  chatId: string;
  sessionId: string;
  lastActivityAt: number;
  messageCount: number;
}

export interface FeishuConnection {
  connect(onMessage: (message: FeishuMessage) => void): Promise<boolean>;
  disconnect(): Promise<void>;
  sendMessage(chatId: string, text: string, messageId?: string, threadId?: string): Promise<void>;
  sendTyping(chatId: string, isTyping: boolean, threadId?: string): Promise<void>;
  isConnected(): boolean;
}

export interface FeishuServiceConfig {
  appId: string;
  appSecret: string;
  onMessage?: (message: FeishuMessage) => void;
  onError?: (error: Error) => void;
}

// 图片上传选项
export interface ImageUploadOptions {
  timeout?: number;       // 超时时间（毫秒）
  maxFileSize?: number;   // 最大文件大小（字节）
  /**
   * 调用方已知的 content-type(由 probe 阶段拿到)。
   * 若提供且为飞书支持类型,可跳过响应头白名单校验,
   * 避免在已经 HEAD 过的情况下因 CDN 返回头不一致被二次拒绝。
   */
  expectedContentType?: string;
}

// 图片上传结果
export interface ImageUploadResult {
  success: boolean;
  imageKey?: string;      // 上传成功后的图片key
  error?: string;         // 错误信息
}

// 文件上传结果
export interface FileUploadResult {
  success: boolean;
  fileKey?: string;       // 上传成功后的文件key
  error?: string;         // 错误信息
}

// 支持图片的消息接口
export interface FeishuMessageWithImage extends FeishuMessage {
  imageKeys?: string[];   // 图片键值列表
}

// 内容处理结果
export interface ContentProcessResult {
  processedText: string;  // 处理后的文本（图片路径替换为Markdown链接）
  imageKeys: string[];    // 上传的图片键值列表
  errors: string[];       // 处理过程中遇到的错误
}

// ==================== NEW: 消息详情（getMessageDetail 返回） ====================

/** im.v1.message.get 返回的消息详情 */
export interface MessageDetail {
  messageId: string;
  parentId?: string;
  rootId?: string;
  msgType: string;
  body: {
    content: string;      // JSON 字符串
  };
  sender?: {
    senderType: string;
    senderId?: {
      openId?: string;
      userId?: string;
    };
  };
  createTime: string;
  updateTime?: string;
}
