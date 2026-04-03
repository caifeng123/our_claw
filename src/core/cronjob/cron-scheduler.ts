/**
 * CronScheduler V2 — 调度引擎
 *
 * 核心改进：
 *   - 轮询 → TimerMap（setTimeout 精准触发）
 *   - 启动恢复：处理中断态 + 按 miss_policy 补偿
 *   - 失败重试：指数退避
 *   - 系统任务 + 用户任务统一调度
 *   - 所有时间判断统一使用东八区
 */

import { CronStore } from './cron-store.js'
import { CronExecutor } from './cron-executor.js'
import { TimerMap } from './timer-map.js'
import { getSystemJobs } from './system-jobs.js'
import { getChinaHour } from './timezone.js'
import type { CronJob, UpdateJobParams } from './types.js'

/** 日志清理定时器间隔：1 小时 */
const LOG_CLEANUP_INTERVAL = 60 * 60 * 1000

export class CronScheduler {
  private store: CronStore
  private executor: CronExecutor
  private timerMap: TimerMap
  private logCleanupTimer: NodeJS.Timeout | null = null

  /** 系统任务的运行状态（内存维护，不持久化） */
  private systemJobStates: Map<string, Pick<CronJob, 'lastRunAt' | 'lastRunStatus' | 'retryCount'>> = new Map()

  constructor(dataDir?: string) {
    const dir = dataDir || './data'
    this.store = new CronStore(dir)
    this.executor = new CronExecutor()

    // TimerMap 的回调：任务到期时触发
    this.timerMap = new TimerMap(async (job) => {
      await this.onJobDue(job)
    })
  }

  // ─────────────────── 生命周期 ───────────────────

  /**
   * 启动调度器
   */
  async start(): Promise<void> {
    console.log('⏰ [Scheduler] 启动中...')

    // 1. 清理过期日志
    this.store.cleanOldLogs(7)

    // 2. 恢复中断态 + 错过补偿
    await this.recover()

    // 3. 加载所有任务到 TimerMap
    const userJobs = this.store.listJobs(true)  // 只加载 enabled
    const systemJobs = getSystemJobs().filter(j => j.enabled)

    // 恢复系统任务的内存状态
    for (const sj of systemJobs) {
      const state = this.systemJobStates.get(sj.id)
      if (state) {
        sj.lastRunAt = state.lastRunAt
        sj.lastRunStatus = state.lastRunStatus
        sj.retryCount = state.retryCount
      }
    }

    this.timerMap.syncAll([...systemJobs, ...userJobs])

    console.log(`⏰ [Scheduler] 已加载 ${userJobs.length} 个用户任务 + ${systemJobs.length} 个系统任务`)

    // 4. 定时清理日志（每小时检查，东八区凌晨 3 点执行）
    this.logCleanupTimer = setInterval(() => {
      const hour = getChinaHour()  // 使用东八区时间
      if (hour === 3) {
        this.store.cleanOldLogs(7)
      }
    }, LOG_CLEANUP_INTERVAL)
  }

  /**
   * 停止调度器
   */
  stop(): void {
    this.timerMap.destroy()
    if (this.logCleanupTimer) {
      clearInterval(this.logCleanupTimer)
      this.logCleanupTimer = null
    }
    console.log('⏰ [Scheduler] 已停止')
  }

  // ─────────────────── 启动恢复 ───────────────────

  /**
   * 处理三种恢复场景：
   *   A. nextRun > now     → 正常，交给 timerMap.sync
   *   B. nextRun <= now    → 错过，按 miss_policy 补偿
   *   C. lastRunStatus = running → 中断态，标记 failed 后按策略处理
   */
  private async recover(): Promise<void> {
    const jobs = this.store.listJobs(true)
    const now = Date.now()
    let recoveredCount = 0

    for (const job of jobs) {
      // Case C: 中断态
      if (job.lastRunStatus === 'running') {
        console.log(`⏰ [Scheduler] 检测到中断任务: ${job.name}`)
        this.store.updateJob(job.id, { lastRunStatus: 'failed' })
        this.store.appendLog({
          jobId: job.id,
          jobName: job.name,
          startedAt: job.lastRunAt || now,
          finishedAt: now,
          status: 'failed',
          error: '进程重启导致任务中断',
          attempt: 1,
        })
        recoveredCount++
      }

      // Case B: 错过执行
      const nextRun = this.timerMap.calcNextRun(job)
      if (nextRun && nextRun <= now) {
        switch (job.missPolicy) {
          case 'skip':
            console.log(`⏰ [Scheduler] 跳过错过的任务: ${job.name}`)
            // 不执行，只更新 lastRunAt 让 timerMap 计算下一周期
            this.store.updateJob(job.id, { lastRunAt: now })
            break

          case 'run_once':
          default:
            console.log(`⏰ [Scheduler] 补偿执行: ${job.name}`)
            try {
              await this.executeAndRecord(job)
            } catch (err) {
              console.error(`⏰ [Scheduler] 补偿执行失败: ${job.name}`, err)
            }
            break
        }
        recoveredCount++
      }
    }

    if (recoveredCount > 0) {
      console.log(`⏰ [Scheduler] 恢复处理了 ${recoveredCount} 个任务`)
    }
  }

  // ─────────────────── 任务执行 ───────────────────

  /**
   * Timer 到期回调
   */
  private async onJobDue(job: CronJob): Promise<void> {
    try {
      // 标记 running
      this.updateJobState(job, { lastRunStatus: 'running', lastRunAt: Date.now() })

      await this.executeAndRecord(job)
    } catch (err) {
      await this.handleFailure(job, err)
    }

    // 无论成功失败，调度下一次
    const fresh = this.getFreshJob(job)
    if (fresh && fresh.enabled) {
      const nextRun = this.timerMap.sync(fresh)
      if (nextRun) {
        this.updateJobState(fresh, { nextRunAt: nextRun })
      }
    }
  }

  /**
   * 执行任务并记录结果
   */
  private async executeAndRecord(job: CronJob): Promise<void> {
    const startedAt = Date.now()

    try {
      const result = await this.executor.execute(job)

      // 成功
      this.updateJobState(job, {
        lastRunAt: startedAt,
        lastRunStatus: 'success',
        retryCount: 0,
      })

      // 单次任务：执行成功后自动禁用
      if (job.once) {
        console.log(`⏰ [Scheduler] 单次任务已完成，自动禁用: ${job.name}`)
        this.updateJobState(job, { enabled: false })
        this.timerMap.remove(job.id)
      }

      this.store.appendLog({
        jobId: job.id,
        jobName: job.name,
        startedAt,
        finishedAt: Date.now(),
        status: 'success',
        result: result.slice(0, 2000),  // 截断过长结果
        attempt: (job.retryCount || 0) + 1,
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)

      this.store.appendLog({
        jobId: job.id,
        jobName: job.name,
        startedAt,
        finishedAt: Date.now(),
        status: 'failed',
        error,
        attempt: (job.retryCount || 0) + 1,
      })

      throw err  // 向上传播，由 handleFailure 处理
    }
  }

  // ─────────────────── 失败重试 ───────────────────

  /**
   * 指数退避重试
   */
  private async handleFailure(job: CronJob, error: unknown): Promise<void> {
    const retryCount = (job.retryCount || 0) + 1
    const maxRetries = job.maxRetries ?? 3
    const errorMsg = error instanceof Error ? error.message : String(error)

    if (retryCount < maxRetries) {
      // 指数退避: delay * 2^(retryCount-1)
      const delay = job.retryDelayMs * Math.pow(2, retryCount - 1)

      console.log(`🔄 [Scheduler] 任务 [${job.name}] 第${retryCount}次重试，${delay / 1000}s 后执行`)

      this.updateJobState(job, {
        lastRunStatus: 'retrying',
        retryCount,
      })

      // 延迟重试
      setTimeout(async () => {
        const fresh = this.getFreshJob(job)
        if (!fresh || !fresh.enabled) return

        // 更新 retryCount
        fresh.retryCount = retryCount

        try {
          await this.executeAndRecord(fresh)
        } catch (retryErr) {
          await this.handleFailure(fresh, retryErr)
        }
      }, delay)
    } else {
      // 超过最大重试次数
      console.error(`❌ [Scheduler] 任务 [${job.name}] 重试 ${maxRetries} 次后仍然失败: ${errorMsg}`)

      this.updateJobState(job, {
        lastRunStatus: 'failed',
        retryCount: 0,
      })

      // 发送失败通知
      if (job.target) {
        try {
          const feishuBridge = this.executor['feishuBridge']
          if (feishuBridge) {
            await feishuBridge.sendText(
              job.target,
              `❌ 定时任务 [${job.name}] 执行失败\n重试 ${maxRetries} 次后仍然失败\n错误: ${errorMsg}`,
            )
          }
        } catch {
          // 通知失败不影响主流程
        }
      }
    }
  }

  // ─────────────────── 任务变更通知 ───────────────────

  /**
   * 任务创建后调用 — 实时设置 timer
   */
  onJobCreated(job: CronJob): number | null {
    const nextRun = this.timerMap.sync(job)
    if (nextRun) {
      this.store.updateJob(job.id, { nextRunAt: nextRun })
    }
    return nextRun
  }

  /**
   * 任务更新后调用 — 实时刷新 timer
   */
  onJobUpdated(job: CronJob): number | null {
    const nextRun = this.timerMap.sync(job)
    if (nextRun) {
      this.store.updateJob(job.id, { nextRunAt: nextRun })
    }
    return nextRun
  }

  /**
   * 任务删除后调用 — 移除 timer
   */
  onJobDeleted(jobId: string): void {
    this.timerMap.remove(jobId)
  }

  /**
   * 手动触发任务
   */
  async triggerJob(jobId: string): Promise<void> {
    const job = this.store.getJob(jobId)
    if (!job) throw new Error(`任务不存在: ${jobId}`)
    if (!job.enabled) throw new Error(`任务已禁用: ${job.name}`)

    this.store.updateJob(jobId, { lastRunStatus: 'running', lastRunAt: Date.now() })

    try {
      await this.executeAndRecord(job)
    } catch (err) {
      await this.handleFailure(job, err)
    }
  }

  // ─────────────────── 对外暴露 ───────────────────

  getStore(): CronStore {
    return this.store
  }

  getExecutor(): CronExecutor {
    return this.executor
  }

  getTimerMap(): TimerMap {
    return this.timerMap
  }

  /**
   * 获取指定任务的下次执行时间
   */
  getNextRunTime(job: CronJob): number | null {
    return this.timerMap.calcNextRun(job)
  }

  // ─────────────────── 内部工具 ───────────────────

  /**
   * 获取最新的 job 数据（从 store 或系统任务）
   */
  private getFreshJob(job: CronJob): CronJob | undefined {
    if (job.system) {
      const systemJobs = getSystemJobs()
      const sj = systemJobs.find(j => j.id === job.id)
      if (sj) {
        const state = this.systemJobStates.get(sj.id)
        if (state) {
          sj.lastRunAt = state.lastRunAt
          sj.lastRunStatus = state.lastRunStatus
          sj.retryCount = state.retryCount
        }
      }
      return sj
    }
    return this.store.getJob(job.id)
  }

  /**
   * 更新 job 状态（区分系统任务和用户任务）
   */
  private updateJobState(job: CronJob, updates: UpdateJobParams): void {
    if (job.system) {
      // 系统任务：只更新内存
      const current = this.systemJobStates.get(job.id) || {
        lastRunAt: null,
        lastRunStatus: null,
        retryCount: 0,
      }
      this.systemJobStates.set(job.id, {
        lastRunAt: updates.lastRunAt ?? current.lastRunAt,
        lastRunStatus: updates.lastRunStatus ?? current.lastRunStatus,
        retryCount: updates.retryCount ?? current.retryCount,
      })
      // 同步到 job 对象
      Object.assign(job, updates)
    } else {
      // 用户任务：持久化到文件
      this.store.updateJob(job.id, updates)
      Object.assign(job, updates)
    }
  }
}
