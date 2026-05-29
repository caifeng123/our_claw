/**
 * 飞书 Markdown 表格列数守卫
 *
 * 飞书卡片 markdown 表格列数上限 = 5。超过会触发渲染错误。
 * 本模块在内容下发前扫描所有 GFM 表格块，对超列表格做「列表化」降级，
 * <=5 列的表格保留原样。
 *
 * 选择「列表化」而非「截列」的理由：
 *   1. 截列会丢字段，信息损失不可逆。
 *   2. 列表化保留全部字段，仅牺牲二维对齐，飞书 markdown 一定渲染成功。
 *
 * 触发条件:
 *   - 同时出现 `| ... |` 表头行 和 `|---|---|...` 分隔行
 *   - 列数 = 表头行中的字段数（以分隔行作为表格存在的判定信号）
 */

const FEISHU_MD_TABLE_MAX_COLS = 5

interface TableBlock {
  startLine: number
  endLine: number
  header: string[]
  rows: string[][]
}

/** 将 `| a | b | c |` 切成 ['a','b','c']，处理首尾空段 */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map(c => c.trim())
}

/** 判断是否是分隔行: `|---|:--:|---|` */
function isSeparatorLine(line: string): boolean {
  return /^\s*\|?\s*(:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line.trim())
}

/** 扫描全文，找出所有 GFM 表格块 */
function findTableBlocks(lines: string[]): TableBlock[] {
  const blocks: TableBlock[] = []
  for (let i = 0; i < lines.length - 1; i++) {
    const headerLine = lines[i]!
    const sepLine = lines[i + 1]!
    if (!headerLine.includes('|')) continue
    if (!isSeparatorLine(sepLine)) continue

    const header = splitRow(headerLine)
    const rows: string[][] = []
    let j = i + 2
    while (j < lines.length && lines[j]!.trim().startsWith('|')) {
      rows.push(splitRow(lines[j]!))
      j++
    }
    blocks.push({ startLine: i, endLine: j - 1, header, rows })
    i = j - 1
  }
  return blocks
}

/**
 * 把单张表降级成 "**N.**" + "- 字段: 值" 列表形式。
 * 全字段保留，仅丢二维对齐。
 */
function tableToList(block: TableBlock): string {
  const out: string[] = []
  block.rows.forEach((row, idx) => {
    out.push(`**${idx + 1}.**`)
    block.header.forEach((col, ci) => {
      const val = row[ci] ?? ''
      // 跳过完全空的字段，避免噪音
      if (!col && !val) return
      out.push(`- **${col || `字段${ci + 1}`}**: ${val}`)
    })
    out.push('') // 行间空行
  })
  return out.join('\n').trimEnd()
}

/**
 * 对 markdown 文本做表格列数守卫（纯函数）。
 * - 列数 ≤ maxCols：保留原表
 * - 列数 > maxCols：替换为列表形式
 */
export function guardMarkdownTables(
  text: string,
  maxCols = FEISHU_MD_TABLE_MAX_COLS,
): string {
  if (!text || !text.includes('|')) return text

  const lines = text.split('\n')
  const blocks = findTableBlocks(lines)
  if (blocks.length === 0) return text

  // 倒序替换，避免行号偏移
  for (let b = blocks.length - 1; b >= 0; b--) {
    const block = blocks[b]!
    if (block.header.length <= maxCols) continue
    const replacement = tableToList(block).split('\n')
    lines.splice(block.startLine, block.endLine - block.startLine + 1, ...replacement)
  }

  return lines.join('\n')
}
