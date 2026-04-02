/**
 * 图片配置 - 统一的格式定义
 */
import mime from 'mime'

export const UPLOADABLE_FORMATS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'ico'] as const

export const IMAGE_MAX_FILE_SIZE = 10 * 1024 * 1024

export const VISION_SYSTEM_PROMPT = `You are a precise image analysis assistant. Analyze the provided image and answer the user's question about it. Be specific and detailed in your observations. If you cannot determine something from the image, say so clearly.`

/**
 * 获取文件的 MIME 类型（基于 mime 库），无后缀时 fallback 为 image/jpeg
 */
export function getImageMimeType(filePath: string): string {
  return mime.getType(filePath) || 'image/jpeg'
}

/**
 * 判断格式是否可直接上传到飞书
 */
export function isUploadable(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return UPLOADABLE_FORMATS.includes(ext as any)
}
