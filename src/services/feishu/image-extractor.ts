/**
 * 图片候选提取器
 *
 * 设计要点:
 *  1. Markdown ![](src) 与 <img src="..."> 是显式图片语法,完整提取 src,
 *     由后续探测层(content-type / magic bytes)判断真实类型。
 *  2. 裸 URL(http/https/file)路径中必须命中图片扩展名才会被收录,
 *     避免普通超链接 [标题](https://example.com/page) 误进图片上传链路。
 *     扩展名之后允许任意 CDN 处理参数(?query / #hash / ~tplv-... / !处理串 等)。
 *  3. 本地路径(Windows / POSIX / 相对)同样以扩展名约束,避免误抓盘符或目录名。
 */

export type ImageCandidateKind = 'url' | 'local'

export interface ImageCandidate {
  /** 原文中的完整字符串。后续替换以此为单位,天然对齐。 */
  raw: string
  kind: ImageCandidateKind
}

// 图片扩展名白名单
const IMG_EXT = 'jpg|jpeg|png|gif|bmp|webp|svg|ico|tiff'

// 裸 URL(http/https/file)兜底匹配 —— URL 路径中必须出现 `.<图片扩展名>`,
// 后面允许常见的 CDN 处理参数(? query / # hash / ~tplv-... / !处理串 / /format/... 等)。
// 例:
//   https://x.cdn/a.png                        ✓
//   https://x.cdn/a.jpg?size=200               ✓
//   https://x.cdn/a.png~tplv-foo.image         ✓ (字节 TOS / ImageX 风格)
//   https://x.cdn/a.jpeg!w200                  ✓ (常见 CDN 处理串)
//   https://example.com/page                   ✗ (无扩展名,正确丢弃)
// 关键:不要无差别抓 URL,否则 markdown 普通链接 [标题](https://example.com/page)
// 会被当成图片候选,触发 probe → 误报"上传失败"。
// 显式语法 ![alt](src) 与 <img src=...> 由下方 MD_RE / HTML_RE 处理,无需扩展名。
const URL_RE = new RegExp(
  `(?:https?|file):\\/\\/[^\\s)"'<>\\]]*?\\.(?:${IMG_EXT})(?:[^\\s)"'<>\\]]*)?`,
  'gi',
)

// Windows 绝对路径,仍约束扩展名(本地路径无歧义,且避免误抓盘符)
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

  // 2. 裸 URL —— 必须带图片扩展名,避免把普通文档链接当成图片
  for (const m of text.matchAll(URL_RE)) push(m[0])

  // 3. 本地路径 —— 仍以扩展名约束
  for (const m of text.matchAll(WIN_RE)) push(m[0])
  for (const m of text.matchAll(POSIX_RE)) push(m[1]!)
  for (const m of text.matchAll(REL_RE)) push(m[1]!)

  return out
}