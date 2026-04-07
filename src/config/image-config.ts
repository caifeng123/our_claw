/**
 * 图片配置 - 统一的格式定义
 */
import mime from 'mime'

export const UPLOADABLE_FORMATS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'ico', 'svg', 'tiff'] as const

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
 * 支持本地文件路径和 URL（自动剥离 query string 和 fragment）
 */
export function isUploadable(filePath: string): boolean {
  let pathToCheck = filePath

  // 如果是 URL，先剥离 query string 和 fragment
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    try {
      const url = new URL(filePath)
      pathToCheck = url.pathname
    } catch {
      // URL 解析失败，回退到原始字符串
    }
  }

  const ext = pathToCheck.split('.').pop()?.toLowerCase() || ''
  return UPLOADABLE_FORMATS.includes(ext as any)
}

/**
 * 判断给定字符串是否为 HTTP/HTTPS URL
 */
export function isHttpUrl(path: string): boolean {
  return path.startsWith('http://') || path.startsWith('https://')
}
