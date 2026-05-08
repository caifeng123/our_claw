/**
 * 图片候选提取器
 *
 * 设计要点:
 *  1. 不依赖文件扩展名识别图片 —— URL/路径只负责"提取候选",
 *     是否真的是图片由后续 content-type / magic bytes 探测决定。
 *  2. Markdown ![](src) 与 <img src="..."> 优先解析,这两种是 100% 拿到完整 src 的形式,
 *     避免被截到 ".png" 就停。
 *  3. 裸 URL/本地路径作为兜底。
 */

export type ImageCandidateKind = 'url' | 'local'

export interface ImageCandidate {
  /** 原文中的完整字符串。后续替换以此为单位,天然对齐。 */
  raw: string
  kind: ImageCandidateKind
}

// 完整 URL(http/https/file),不要求扩展名
const URL_RE = /(?:https?|file):\/\/[^\s)"'<>\]]+/gi

// Windows 绝对路径,仍约束扩展名(本地路径无歧义,且避免误抓盘符)
const IMG_EXT = 'jpg|jpeg|png|gif|bmp|webp|svg|ico|tiff'
const WIN_RE = new RegExp(`[a-zA-Z]:\\\\[^\\s)"'<>]+\\.(?:${IMG_EXT})`, 'gi')

// POSIX 路径(./... /... ../...)
const POSIX_RE = new RegExp(
  `(?:^|[\\s(])((?:\\.{0,2}\\/|\\/)[^\\s)"'<>]+\\.(?:${IMG_EXT}))`,
  'gi',
)

// 相对路径形如 a/b.png(无前导 . 或 /)
const REL_RE = new RegExp(
  `(?:^|[\\s(])([a-zA-Z][a-zA-Z0-9_-]*\\/[^\\s)"'<>]+\\.(?:${IMG_EXT}))`,
  'gi',
)

// Markdown 图片语法
const MD_RE = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g

// HTML <img src="...">
const HTML_RE = /<img\s[^>]*?src=["']([^"']+)["']/gi

function classify(src: string): ImageCandidateKind {
  return /^(https?|file):\/\//i.test(src) ? 'url' : 'local'
}

export function extractImageCandidates(text: string): ImageCandidate[] {
  const seen = new Set<string>()
  const out: ImageCandidate[] = []

  const push = (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    out.push({ raw: trimmed, kind: classify(trimmed) })
  }

  // 1. Markdown / HTML 显式语法 —— 优先,完整 src
  for (const m of text.matchAll(MD_RE)) push(m[1]!)
  for (const m of text.matchAll(HTML_RE)) push(m[1]!)

  // 2. 裸 URL —— 不要求扩展名,交给探测层判定
  for (const m of text.matchAll(URL_RE)) push(m[0])

  // 3. 本地路径 —— 仍以扩展名约束
  for (const m of text.matchAll(WIN_RE)) push(m[0])
  for (const m of text.matchAll(POSIX_RE)) push(m[1]!)
  for (const m of text.matchAll(REL_RE)) push(m[1]!)

  return out
}
