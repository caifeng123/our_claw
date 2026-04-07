/**
 * 图片管道上下文 - 全局单例模式
 * 桥接 MCP 工具与每个请求的 FeishuService 和 StreamingCardRenderer
 */

export interface FeishuUploader {
  uploadImage(imagePath: string): Promise<string>
  uploadImageFromUrl(imageUrl: string): Promise<string>
}

interface ActiveRenderer {
  registerImage(imageKey: string, alt: string): void
}

let feishuUploader: FeishuUploader | null = null
let activeRenderer: ActiveRenderer | null = null
let activeSessionId: string | null = null

export function setFeishuUploader(uploader: FeishuUploader): void {
  feishuUploader = uploader
}

export function setActiveRequest(sessionId: string, renderer: ActiveRenderer): void {
  activeRenderer = renderer
  activeSessionId = sessionId
}

export function clearActiveRequest(): void {
  const prev = activeSessionId
  activeRenderer = null
  activeSessionId = null
  if (prev) {
  }
}

export function getFeishuUploader(): FeishuUploader | null {
  return feishuUploader
}

export function getActiveRenderer(): ActiveRenderer | null {
  return activeRenderer
}

export function getActiveSessionId(): string | null {
  return activeSessionId
}
