// src/core/self-iteration/iteration-checker.ts
// 迭代检查器 (V5.1) — 薄 checker，只负责发现 + 派发 SubAgent
//
// V5.1 修复：
//   - discoverSkillsWithTraces / processSkill 改为查找前一天的 trace 文件
//     0:10 触发时日期已翻到新一天，需要分析的是前一天积累的 trace

import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { ClaudeEngine } from '../agent/engine/claude-engine.js'
import type {
  NightlyReport,
  NightlySkillReport,
} from './types.js'
import { isPersonalSkill } from './metadata-parser.js'
import {
  PERSONAL_SKILL_SYSTEM_PROMPT,
  OTHERS_SKILL_SYSTEM_PROMPT,
} from './prompts.js'
import { SKILLS_DIR } from './config.js'
import { SESSIONS_ROOT } from '../../utils/paths.js'

// ==================== 时区工具 ====================

const TIMEZONE = 'Asia/Shanghai'

/**
 * 获取前一天的中国标准时间 YYYY-MM-DD 日期字符串
 */
function getYesterdayChinaDate(): string {
  const yesterday = new Date(Date.now() - 86_400_000)
  return yesterday.toLocaleDateString('sv-SE', { timeZone: TIMEZONE })
}

export class IterationChecker {
  private claudeEngine: ClaudeEngine

  constructor(claudeEngine: ClaudeEngine) {
    this.claudeEngine = claudeEngine
  }

  // ─── 入口 ───

  async runNightly(skillFilter: 'all' | string[]): Promise<NightlyReport> {
    const report: NightlyReport = {
      runAt: new Date().toLocaleString('sv-SE', { timeZone: TIMEZONE }).replace(' ', 'T') + '+08:00',
      skills: [],
    }

    const skills = skillFilter === 'all'
      ? this.discoverSkillsWithTraces()
      : skillFilter

    console.log(`🌙 [IterationChecker] Nightly run: ${skills.length} skill(s) to check`)

    for (const skillName of skills) {
      const skillReport = await this.processSkill(skillName)
      report.skills.push(skillReport)
    }

    const analyzed = report.skills.filter(s => s.action === 'analyzed').length
    const optimized = report.skills.filter(s => s.action === 'optimized').length
    const skipped = report.skills.filter(s => s.action === 'skipped').length

    console.log(
      `🌙 [IterationChecker] Nightly complete: ` +
      `${optimized} optimized, ${analyzed} analyzed, ${skipped} skipped`,
    )

    return report
  }

  // ─── 单个 Skill 处理 ───

  private async processSkill(skillName: string): Promise<NightlySkillReport> {
    try {
      const yesterday = getYesterdayChinaDate()
      const skillDir = join(SKILLS_DIR, skillName)
      const traceFile = join(skillDir, 'iteration', 'traces', `${yesterday}.jsonl`)

      // 无 trace 则跳过
      if (!existsSync(traceFile)) {
        return { skillName, tracesAnalyzed: 0, action: 'skipped', reason: `No traces for ${yesterday}` }
      }

      // 判断 Skill 类型
      const skillMd = this.loadSkillMd(skillName)
      const personal = isPersonalSkill(skillMd)
      const typeLabel = personal ? 'personal' : 'others'

      console.log(`📊 [IterationChecker] "${skillName}": type=${typeLabel}, dispatching to SubAgent`)

      // 构建 SubAgent 的 userPrompt — 只传路径和元数据
      const userPrompt = [
        `skillName: ${skillName}`,
        `skillDir: ${skillDir}`,
        `traceFile: ${traceFile}`,
        `sessionsDir: ${SESSIONS_ROOT}`,
        `skillType: ${typeLabel}`,
        `date: ${yesterday}`,
      ].join('\n')

      const systemPrompt = personal
        ? PERSONAL_SKILL_SYSTEM_PROMPT
        : OTHERS_SKILL_SYSTEM_PROMPT

      // SubAgent 自行读文件、分析、写入
      await this.claudeEngine.sendMessage(userPrompt, systemPrompt)

      return {
        skillName,
        tracesAnalyzed: -1, // SubAgent 自行计数，checker 不再关心
        action: personal ? 'optimized' : 'analyzed',
        reason: `${typeLabel} skill dispatched to SubAgent`,
      }
    } catch (err) {
      console.error(`[IterationChecker] Error processing "${skillName}":`, err)
      return {
        skillName,
        tracesAnalyzed: 0,
        action: 'error',
        reason: `Error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // ─── SKILL.md 加载（仅用于判断 personal/others） ───

  private loadSkillMd(skillName: string): string {
    
    const candidates = [
      join(SKILLS_DIR, skillName, 'SKILL.md'),
      join(SKILLS_DIR, skillName, 'skill.md'),
      join(SKILLS_DIR, `${skillName}.md`),
    ]

    for (const p of candidates) {
      if (existsSync(p)) {
        try {
          return readFileSync(p, 'utf-8')
        } catch {
          continue
        }
      }
    }

    return '(SKILL.md not found)'
  }

  // ─── Skill 发现 ───

  private discoverSkillsWithTraces(): string[] {
    if (!existsSync(SKILLS_DIR)) return []

    const yesterday = getYesterdayChinaDate()

    try {
      return readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .filter(e => {
          const traceFile = join(SKILLS_DIR, e.name, 'iteration', 'traces', `${yesterday}.jsonl`)
          return existsSync(traceFile)
        })
        .map(e => e.name)
    } catch {
      return []
    }
  }
}
