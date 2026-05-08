/**
 * 图片探测器
 *
 * 不依赖文件扩展名识别 URL 是否为图片:
 *  - 远程 URL: HEAD 拿 content-type,不支持时降级 Range GET 1 字节
 *  - 本地文件: mime.getType() 拿 content-type
 *
 * 借助 mime 包做 content-type ↔ extension 双向映射,
 * 不再维护手写扩展名白名单。
 */

import mime from 'mime'
import { readFileSync } from 'fs'

export interface ProbeResult {
  ok: boolean
  contentType?: string
  /** 标准化扩展名(由 mime 反查得到,如 'png'),用于飞书校验 */
  ext?: string
  error?: string
}

const IMAGE_MIME_PREFIX = 'image/'

/**
 * 飞书图片消息支持的 mime 类型(以 mime 包标准化结果为准)。
 * 与本地上传白名单保持一致,集中收口。
 */
const FEISHU_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/bmp',
  'image/webp',
  'image/svg+xml',
])

/**
 * 由 content-type 判断飞书是否支持上传
 */
export function isFeishuSupportedMime(contentType: string | undefined | null): boolean {
  if (!contentType) return false
  return FEISHU_IMAGE_MIMES.has(contentType.toLowerCase())
}

/**
 * 由 mime 包反查标准扩展名(供日志/调试使用)
 */
export function extFromMime(contentType: string | undefined | null): string | undefined {
  if (!contentType) return undefined
  return mime.getExtension(contentType.toLowerCase()) ?? undefined
}

/**
 * 探测远程 URL 是否为图片
 */
export async function probeRemoteImage(url: string, timeoutMs = 5000): Promise<ProbeResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let res: Response
    try {
      res = await fetch(url, { method: 'HEAD', signal: ctrl.signal })
    } catch {
      // 部分 CDN 不支持 HEAD,降级到 Range GET
      res = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: ctrl.signal,
      })
    }

    if (!res.ok && res.status !== 206) {
      return { ok: false, error: `HTTP ${res.status}` }
    }

    const ctRaw = res.headers.get('content-type') ?? ''
    const contentType = ctRaw.split(';')[0]?.trim().toLowerCase() || undefined

    if (!contentType?.startsWith(IMAGE_MIME_PREFIX)) {
      // 没有 content-type 或不是图片时,再用 URL 后缀兜底一次
      const guessed = mime.getType(url) ?? undefined
      if (guessed?.startsWith(IMAGE_MIME_PREFIX)) {
        return { ok: true, contentType: guessed, ext: extFromMime(guessed) }
      }
      return { ok: false, contentType, error: `Not an image (content-type=${contentType ?? 'unknown'})` }
    }

    return { ok: true, contentType, ext: extFromMime(contentType) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'probe failed' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 探测本地文件是否为图片(基于 mime 包按扩展名判定)
 *
 * 注:本地路径已被提取层用扩展名约束过,这里只复核类型并返回标准化 mime。
 */
export function probeLocalImage(filePath: string): ProbeResult {
  const contentType = mime.getType(filePath) ?? undefined
  if (!contentType?.startsWith(IMAGE_MIME_PREFIX)) {
    return { ok: false, contentType, error: `Not an image (content-type=${contentType ?? 'unknown'})` }
  }
  return { ok: true, contentType, ext: extFromMime(contentType) }
}

/**
 * 读取本地文件 magic bytes 做更可靠的判定(可选,扩展名造假时使用)
 */
export function sniffLocalImageMime(filePath: string): string | undefined {
  try {
    const buf = readFileSync(filePath, { flag: 'r' }).subarray(0, 16)
    if (buf.length < 4) return undefined
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
    if (
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) return 'image/webp'
    return undefined
  } catch {
    return undefined
  }
}
