/**
 * CronStore V2 — 持久化存储
 *
 * 只管理用户任务。系统任务由 system-jobs.ts 硬编码提供。
 *
 * 存储结构：
 *   data/cronjobs.json      — 用户任务列表 { jobs: CronJob[] }
 *   data/cronjob-logs.jsonl  — 执行日志（append-only, 每行一条 JSON）
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import type {
  CronJob,
  CreateJobParams,
  UpdateJobParams,
  CronJobLog,
  DEFAULT_TIMEOUT_MS,
} from './types.js'
import { DEFAULT_TIMEOUT_MS as TIMEOUTS } from './types.js'

interface StoreFile {
  jobs: CronJob[]
}

export class CronStore {
  private jobsPath: string
  private logsPath: string

  constructor(dataDir: string) {
    // 确保目录存在
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true })
    }

    this.jobsPath = join(dataDir, 'cronjobs.json')
    this.logsPath = join(dataDir, 'cronjob-logs.jsonl')

    // 初始化空文件
    if (!existsSync(this.jobsPath)) {
      this.writeJobs([])
    }
  }

  // ─────────────────── 任务 CRUD ───────────────────

  /**
   * 创建任务
   */
  createJob(params: CreateJobParams): CronJob {
    const now = Date.now()
    const defaultTimeout = TIMEOUTS[params.taskType] ?? 120_000

    const job: CronJob = {
      // 定义层
      id: randomUUID(),
      name: params.name,
      cron: params.cron,
      taskType: params.taskType,
      taskConfig: params.taskConfig,
      target: params.target,
      createdAt: now,

      // 配置层（用户可指定或使用默认值）
      enabled: params.enabled ?? true,
      missPolicy: params.missPolicy ?? 'run_once',
      maxRetries: params.maxRetries ?? 3,
      retryDelayMs: params.retryDelayMs ?? 60_000,
      timeoutMs: params.timeoutMs ?? defaultTimeout,

      // 运行层（初始化为空）
      lastRunAt: null,
      lastRunStatus: null,
      nextRunAt: null,
      retryCount: 0,
    }

    const jobs = this.readJobs()
    jobs.push(job)
    this.writeJobs(jobs)

    console.log(`📝 [CronStore] 任务已创建: ${job.name} (${job.id})`)
    return job
  }

  /**
   * 获取单个任务
   */
  getJob(jobId: string): CronJob | undefined {
    return this.readJobs().find(j => j.id === jobId)
  }

  /**
   * 列出所有任务
   */
  listJobs(enabledOnly = false): CronJob[] {
    const jobs = this.readJobs()
    return enabledOnly ? jobs.filter(j => j.enabled) : jobs
  }

  /**
   * 更新任务
   */
  updateJob(jobId: string, updates: UpdateJobParams): CronJob | undefined {
    const jobs = this.readJobs()
    const index = jobs.findIndex(j => j.id === jobId)
    if (index === -1) return undefined

    // 合并更新
    jobs[index] = { ...jobs[index], ...updates }
    this.writeJobs(jobs)

    return jobs[index]
  }

  /**
   * 删除任务
   */
  deleteJob(jobId: string): boolean {
    const jobs = this.readJobs()
    const filtered = jobs.filter(j => j.id !== jobId)
    if (filtered.length === jobs.length) return false

    this.writeJobs(filtered)
    console.log(`🗑️ [CronStore] 任务已删除: ${jobId}`)
    return true
  }

  // ─────────────────── 日志操作 ───────────────────

  /**
   * 追加执行日志
   */
  appendLog(log: Omit<CronJobLog, 'id'>): void {
    const fullLog: CronJobLog = {
      ...log,
      id: randomUUID(),
    }

    try {
      appendFileSync(this.logsPath, JSON.stringify(fullLog) + '\n', 'utf-8')
    } catch (err) {
      console.error('📝 [CronStore] 写入日志失败:', err)
    }
  }

  /**
   * 获取指定任务的执行日志
   */
  getJobLogs(jobId: string, limit = 10): CronJobLog[] {
    if (!existsSync(this.logsPath)) return []

    try {
      const content = readFileSync(this.logsPath, 'utf-8')
      const allLogs: CronJobLog[] = content
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          try { return JSON.parse(line) }
          catch { return null }
        })
        .filter((log): log is CronJobLog => log !== null)

      // 按时间倒序，取最近 N 条
      return allLogs
        .filter(log => log.jobId === jobId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit)
    } catch {
      return []
    }
  }

  /**
   * 清理过期日志（保留最近 N 天）
   */
  cleanOldLogs(retentionDays = 7): number {
    if (!existsSync(this.logsPath)) return 0

    try {
      const content = readFileSync(this.logsPath, 'utf-8')
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
      const lines = content.split('\n').filter(line => line.trim())
      const kept: string[] = []
      let removed = 0

      for (const line of lines) {
        try {
          const log = JSON.parse(line) as CronJobLog
          if (log.startedAt >= cutoff) {
            kept.push(line)
          } else {
            removed++
          }
        } catch {
          // 损坏的行丢弃
          removed++
        }
      }

      if (removed > 0) {
        writeFileSync(this.logsPath, kept.join('\n') + (kept.length ? '\n' : ''), 'utf-8')
        console.log(`🧹 [CronStore] 清理了 ${removed} 条过期日志`)
      }

      return removed
    } catch {
      return 0
    }
  }

  // ─────────────────── 内部方法 ───────────────────

  private readJobs(): CronJob[] {
    try {
      const content = readFileSync(this.jobsPath, 'utf-8')
      const data: StoreFile = JSON.parse(content)
      return data.jobs || []
    } catch {
      return []
    }
  }

  /**
   * 原子写入：先写 .tmp 再 rename
   */
  private writeJobs(jobs: CronJob[]): void {
    const data: StoreFile = { jobs }
    const tmpPath = this.jobsPath + '.tmp'

    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
      renameSync(tmpPath, this.jobsPath)
    } catch (err) {
      console.error('📝 [CronStore] 写入失败:', err)
      throw err
    }
  }
}
