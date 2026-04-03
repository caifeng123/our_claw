/**
 * TimerMap — setTimeout 精准调度管理器
 *
 * 封装所有 timer 生命周期管理的复杂度：
 *   - sync(job)     → 清旧 timer + 算下次时间 + 设新 timer
 *   - remove(jobId) → 清 timer
 *   - syncAll(jobs)  → 批量 sync
 *   - destroy()      → 清理所有 timer
 *
 * 内部处理：
 *   - 超长间隔（>24.8 天）自动分段接力
 *   - 已过期的 nextRun 立即触发
 *   - disabled job 只清不设
 */

import cronParser from 'cron-parser'
import type { CronJob } from './types.js'

/** setTimeout 最大安全延时: 2^31 - 1 ms ≈ 24.85 天 */
const MAX_TIMEOUT_MS = 2_147_483_647

interface TimerEntry {
  timer: NodeJS.Timeout
  nextRun: number
}

export type TimerCallback = (job: CronJob) => Promise<void>

export class TimerMap {
  private timers: Map<string, TimerEntry> = new Map()
  private callback: TimerCallback

  constructor(callback: TimerCallback) {
    this.callback = callback
  }

  /**
   * 同步单个 job 的 timer
   * - 如果 job disabled → 清除 timer
   * - 如果 nextRun 已过期 → 立即触发
   * - 如果 nextRun 超过 MAX_TIMEOUT → 分段接力
   * - 正常情况 → 精准 setTimeout
   *
   * @returns nextRun 时间戳，null 表示无法计算
   */
  sync(job: CronJob): number | null {
    // 1. 清除旧 timer
    this.clear(job.id)

    // 2. disabled → 不设 timer
    if (!job.enabled) return null

    // 3. 计算下次执行时间
    const nextRun = this.calcNextRun(job)
    if (nextRun === null) {
      console.error(`⏰ [TimerMap] 无法计算 nextRun: ${job.name} (${job.cron})`)
      return null
    }

    // 4. 设置 timer
    const now = Date.now()
    const delay = nextRun - now

    if (delay <= 0) {
      // 已过期，立即触发（使用 setImmediate 避免同步递归）
      const timer = setTimeout(() => {
        this.timers.delete(job.id)
        this.callback(job).catch(err =>
          console.error(`⏰ [TimerMap] 回调执行错误: ${job.name}`, err)
        )
      }, 0)
      this.timers.set(job.id, { timer, nextRun })
    } else if (delay > MAX_TIMEOUT_MS) {
      // 超长间隔，设置中转 timer（到期后重新 sync，不执行任务）
      const timer = setTimeout(() => {
        this.timers.delete(job.id)
        this.sync(job)  // 递归 sync，会继续接力直到 delay <= MAX_TIMEOUT
      }, MAX_TIMEOUT_MS)
      this.timers.set(job.id, { timer, nextRun })
    } else {
      // 正常情况，精准 setTimeout
      const timer = setTimeout(() => {
        this.timers.delete(job.id)
        this.callback(job).catch(err =>
          console.error(`⏰ [TimerMap] 回调执行错误: ${job.name}`, err)
        )
      }, delay)
      this.timers.set(job.id, { timer, nextRun })
    }

    return nextRun
  }

  /**
   * 批量同步所有 jobs
   */
  syncAll(jobs: CronJob[]): void {
    for (const job of jobs) {
      this.sync(job)
    }
  }

  /**
   * 移除指定 job 的 timer
   */
  remove(jobId: string): void {
    this.clear(jobId)
  }

  /**
   * 销毁所有 timer（用于 graceful shutdown）
   */
  destroy(): void {
    for (const [id, entry] of this.timers) {
      clearTimeout(entry.timer)
    }
    this.timers.clear()
    console.log('⏰ [TimerMap] 所有 timer 已清理')
  }

  /**
   * 获取指定 job 的 nextRun 时间
   */
  getNextRun(jobId: string): number | null {
    return this.timers.get(jobId)?.nextRun ?? null
  }

  /**
   * 获取当前活跃 timer 数量
   */
  get size(): number {
    return this.timers.size
  }

  // ─────────────────── 内部方法 ───────────────────

  /**
   * 计算下次执行时间
   */
  calcNextRun(job: CronJob): number | null {
    try {
      // 基准时间：上次执行时间 > 创建时间
      const baseTime = job.lastRunAt || job.createdAt
      const interval = cronParser.parseExpression(job.cron, {
        currentDate: new Date(baseTime),
        tz: 'Asia/Shanghai',
      })
      return interval.next().getTime()
    } catch (err) {
      console.error(`⏰ [TimerMap] cron 解析失败: ${job.cron}`, err)
      return null
    }
  }

  /**
   * 清除指定 job 的 timer
   */
  private clear(jobId: string): void {
    const entry = this.timers.get(jobId)
    if (entry) {
      clearTimeout(entry.timer)
      this.timers.delete(jobId)
    }
  }
}
