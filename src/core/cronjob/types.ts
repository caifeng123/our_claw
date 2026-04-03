/**
 * CronJob V2 — 类型定义
 *
 * 数据模型分三层：
 *   定义层 — 用户创建时确定，不可变
 *   配置层 — 策略参数，可后续修改
 *   运行层 — 系统自动维护
 */

// ─────────────────── 任务类型 ───────────────────

/** 用户可选的任务类型 */
export type UserTaskType = 'agent_prompt' | 'feishu_notify' | 'custom_script'

/** 包含系统内部类型 */
export type CronTaskType = UserTaskType | 'self_iteration'

// ─────────────────── 错过补偿策略 ───────────────────

/**
 * run_once — 不管错过几次，只补执行一次（默认）
 * skip    — 直接跳到下一个周期
 */
export type MissPolicy = 'run_once' | 'skip'

// ─────────────────── 运行状态 ───────────────────

export type RunStatus = 'running' | 'success' | 'failed' | 'retrying'

// ─────────────────── 通知目标 ───────────────────

/**
 * 通知目标，根据 ID 前缀自动判断类型：
 * - oc_ 开头 → 群聊 (chat_id)
 * - ou_ 开头 → 个人私聊 (open_id)
 */
export type NotifyTarget = string

// ─────────────────── TaskConfig 类型 ───────────────────

export interface AgentPromptConfig {
  prompt: string
  context?: string
}

export interface FeishuNotifyConfig {
  messageTemplate: string
}

export interface CustomScriptConfig {
  command: string
}

export interface SelfIterationConfig {
  skills: string  // 'all' 或逗号分隔的 skill 名
}

export type TaskConfig =
  | AgentPromptConfig
  | FeishuNotifyConfig
  | CustomScriptConfig
  | SelfIterationConfig

// ─────────────────── CronJob 主结构 ───────────────────

export interface CronJob {
  // ── 定义层（创建时确定）──
  id: string
  name: string
  cron: string
  taskType: CronTaskType
  taskConfig: TaskConfig
  target: NotifyTarget
  createdAt: number

  // ── 配置层（可后续修改）──
  enabled: boolean
  missPolicy: MissPolicy
  maxRetries: number
  retryDelayMs: number
  timeoutMs: number

  // ── 运行层（系统自动维护）──
  lastRunAt: number | null
  lastRunStatus: RunStatus | null
  nextRunAt: number | null
  retryCount: number

  // ── 标记 ──
  system?: boolean  // 系统内置任务标记
}

// ─────────────────── 创建参数（不含运行层字段）───────────────────

export interface CreateJobParams {
  name: string
  cron: string
  taskType: CronTaskType
  taskConfig: TaskConfig
  target: NotifyTarget
  enabled?: boolean
  missPolicy?: MissPolicy
  maxRetries?: number
  retryDelayMs?: number
  timeoutMs?: number
  system?: boolean
}

// ─────────────────── 更新参数 ───────────────────

export type UpdateJobParams = Partial<
  Pick<CronJob,
    | 'name' | 'cron' | 'taskConfig' | 'target'
    | 'enabled' | 'missPolicy' | 'maxRetries'
    | 'retryDelayMs' | 'timeoutMs'
    // 运行层字段也允许系统内部更新
    | 'lastRunAt' | 'lastRunStatus' | 'nextRunAt' | 'retryCount'
  >
>

// ─────────────────── 执行日志 ───────────────────

export interface CronJobLog {
  id: string
  jobId: string
  jobName: string
  startedAt: number
  finishedAt: number
  status: 'success' | 'failed' | 'timeout'
  result?: string
  error?: string
  attempt: number   // 第几次尝试（1 = 首次，>1 = 重试）
}

// ─────────────────── 默认超时配置 ───────────────────

export const DEFAULT_TIMEOUT_MS: Record<CronTaskType, number> = {
  agent_prompt: 120_000,
  feishu_notify: 15_000,
  custom_script: 30_000,
  self_iteration: 300_000,
}
