/**
 * CronJob Agent 工具 V2
 *
 * 5 个工具，让用户通过飞书自然语言管理定时任务：
 *   1. create_cronjob  — 创建定时任务
 *   2. update_cronjob  — 修改定时任务
 *   3. list_cronjobs   — 查看任务列表
 *   4. manage_cronjob  — 启用/禁用/删除/手动触发
 *   5. get_cronjob_logs — 查看执行日志
 */

import z from 'zod'
import type { RegisteredTool } from '../types/tools.js'
import type { CronScheduler } from '../../cronjob/cron-scheduler.js'
import type {
  AgentPromptConfig,
  FeishuNotifyConfig,
  CustomScriptConfig,
  UserTaskType,
  MissPolicy,
} from '../../cronjob/types.js'
import { DEFAULT_TIMEOUT_MS } from '../../cronjob/types.js'

export function createCronjobTools(scheduler: CronScheduler): RegisteredTool[] {
  const store = scheduler.getStore()

  // ==================== 1. 创建定时任务 ====================

  const createCronjob: RegisteredTool = {
    name: 'create_cronjob',

    description: `创建一个定时自动执行的任务。

## 核心概念
定时任务在 **独立会话** 中执行，没有任何对话历史。
因此你填入的所有信息必须 **完全自包含**，不能依赖当前对话上下文。

## 任务类型选择
| 类型 | 何时使用 | 示例 |
|------|---------|------|
| agent_prompt | 需要 AI 思考、搜索、分析、生成内容 | 新闻摘要、数据分析、周报生成 |
| feishu_notify | 固定文本提醒，无需 AI 参与 | 站会提醒、打卡提醒、deadline 提醒 |
| custom_script | 执行 shell 命令 | 健康检查、日志清理、数据备份 |

核心判断标准：消息内容在创建时就能完全确定 → feishu_notify；必须在执行时通过搜索/分析/生成才能得到 → agent_prompt。

## prompt 编写规范（agent_prompt 专用）
你必须将用户的简略描述扩展为一份完整的执行指令。检查以下清单：

□ 目标明确 — 具体做什么，不能用"那个""上次""继续"等依赖上下文的表述
□ 数据来源 — 从哪获取信息（搜索什么关键词、访问什么网站、调用什么工具）
□ 范围边界 — 地点、时间范围、数量、业务线等关键约束
□ 输出格式 — 表格/列表/卡片/简报，是否使用 emoji，长度限制
□ 语言 — 中文/英文/其他

如果用户的描述缺少以上任何关键要素，你应该 **先追问再创建**，不要擅自假设。
例如用户说"每天发天气"但没说城市，应追问"请问需要哪个城市的天气？"

## context 与 prompt 的区别
- context: 不变的背景信息（角色设定、团队信息、业务背景），每次执行注入系统提示词
- prompt: 每次执行的具体指令

示例：
  context: "你是一个天气播报助手，面向北京地区的研发团队，使用中文输出。"
  prompt: "查询北京今天的天气预报，包含温度、湿度、天气状况、穿衣建议和是否带伞，用 emoji 简洁格式输出，控制在 10 行以内。"

## target 规则
- 用户说"发到群里/发到这个群" → 传当前会话的 chat_id（oc_ 开头）
- 用户说"发给我/私聊发我" → 传该用户的 open_id（ou_ 开头）
- 用户指定了其他人 → 需要先确认目标用户的 open_id

## 单次 vs 周期任务
- 用户说"5分钟后""明天下午3点""下周一提醒我" → **单次任务**，设置 once=true
- 用户说"每天""每周""每小时" → **周期任务**，once=false（默认）

单次任务执行成功后会自动禁用，不会重复触发。

## cron 表达式（⚠️ 北京时间）
**所有 cron 中的"时"字段都是北京时间（Asia/Shanghai, UTC+8），不是 UTC！**
用户说"早上9点" → 小时填 9；用户说"下午3点" → 小时填 15。
如果你从 get_current_time 获取到当前时间，请确认使用的是北京时间小时数。

格式：分 时 日 月 周几
常用：
  "0 9 * * *"     每天北京时间 9:00
  "0 9 * * 1-5"   工作日北京时间 9:00
  "0 9,18 * * *"  每天北京时间 9:00 和 18:00
  "*/30 * * * *"  每 30 分钟
  "0 0 * * 1"     每周一北京时间 0:00
预设：@hourly @daily @weekly @monthly

## messageTemplate 变量（feishu_notify 专用）
可用变量：{{date}} {{time}} {{weekday}} {{datetime}}
示例："今天是 {{date}} {{weekday}}，别忘了 10:00 的站会！"`,

    inputSchema: {
      name: z.string().describe(
        '任务名称，简洁有辨识度，如"每日科技早报""工作日站会提醒"'
      ),
      cron: z.string().describe(
        'cron 表达式或预设（@daily 等）。⚠️ 时/分必须使用北京时间（Asia/Shanghai），不要用 UTC'
      ),
      taskType: z.enum(['agent_prompt', 'feishu_notify', 'custom_script']).describe(
        '任务类型'
      ),
      target: z.string().describe(
        '结果发送目标。群聊传 chat_id（oc_ 开头），个人传 open_id（ou_ 开头）'
      ),
      once: z.boolean().optional().describe(
        '是否为单次任务。用户说"X分钟后""明天X点""下周一"等一次性场景时设为 true，执行后自动禁用。默认 false（周期任务）'
      ),

      // agent_prompt 专用
      prompt: z.string().optional().describe(
        '[agent_prompt 必填] 完整的执行指令，必须自包含，参照上述编写规范'
      ),
      context: z.string().optional().describe(
        '[agent_prompt 可选] 持久化背景信息（角色设定、团队背景等），注入系统提示词'
      ),

      // feishu_notify 专用
      messageTemplate: z.string().optional().describe(
        '[feishu_notify 必填] 通知文本模板，支持 {{date}} {{time}} {{weekday}} {{datetime}} 变量'
      ),

      // custom_script 专用
      command: z.string().optional().describe(
        '[custom_script 必填] 要执行的 shell 命令'
      ),

      // 策略配置
      missPolicy: z.enum(['run_once', 'skip']).optional().describe(
        '错过执行时的补偿策略。run_once: 补执行一次（默认）；skip: 跳到下个周期'
      ),
      maxRetries: z.number().optional().describe(
        '失败后最大重试次数，默认 3。重试间隔按指数退避递增（1min→2min→4min）'
      ),
      timeoutSec: z.number().optional().describe(
        '执行超时秒数。默认：agent_prompt=120, custom_script=30, feishu_notify=15'
      ),
    },

    execute: async (args) => {
      try {
        const taskType = args.taskType as UserTaskType

        // 参数校验
        const validation = validateTaskParams(taskType, args)
        if (validation) {
          return { success: false, error: validation }
        }

        // 组装 taskConfig
        const taskConfig = buildTaskConfig(taskType, args)

        // 计算超时
        const timeoutMs = args.timeoutSec
          ? args.timeoutSec * 1000
          : DEFAULT_TIMEOUT_MS[taskType]

        // 创建任务
        const job = store.createJob({
          name: args.name,
          cron: args.cron,
          taskType,
          taskConfig,
          target: args.target,
          once: args.once ?? false,
          missPolicy: (args.missPolicy as MissPolicy) || 'run_once',
          maxRetries: args.maxRetries ?? 3,
          timeoutMs,
        })

        // 设置 timer
        const nextRun = scheduler.onJobCreated(job)
        const nextRunStr = nextRun
          ? new Date(nextRun).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          : '计算中'

        // 目标描述
        const targetDesc = args.target.startsWith('ou_')
          ? '私聊发送给用户'
          : '发送到群聊'

        return {
          success: true,
          output: [
            '✅ 定时任务创建成功',
            `📌 名称: ${job.name}`,
            `🔑 ID: ${job.id}`,
            `⏰ 表达式: ${job.cron}`,
            `📋 类型: ${job.taskType}`,
            `📨 目标: ${targetDesc}`,
            `📅 下次执行: ${nextRunStr}`,
            `🔄 错过策略: ${job.missPolicy} | 最大重试: ${job.maxRetries}次`,
          ].join('\n'),
        }
      } catch (error) {
        return {
          success: false,
          error: `创建失败: ${error instanceof Error ? error.message : '未知错误'}`,
        }
      }
    },
  }

  // ==================== 2. 修改定时任务 ====================

  const updateCronjob: RegisteredTool = {
    name: 'update_cronjob',

    description: `修改已有定时任务的配置。

可修改的字段：
- name: 任务名称
- cron: cron 表达式
- target: 发送目标
- prompt / context: agent_prompt 的执行指令和背景
- messageTemplate: feishu_notify 的模板
- command: custom_script 的命令
- missPolicy: 错过补偿策略
- maxRetries: 最大重试次数
- timeoutSec: 超时秒数

注意：修改后 timer 会实时刷新，下次执行时间会重新计算。`,

    inputSchema: {
      jobId: z.string().describe('任务 ID'),
      name: z.string().optional().describe('新的任务名称'),
      cron: z.string().optional().describe('新的 cron 表达式'),
      target: z.string().optional().describe('新的发送目标'),
      prompt: z.string().optional().describe('新的 Agent 执行指令'),
      context: z.string().optional().describe('新的背景信息'),
      messageTemplate: z.string().optional().describe('新的通知模板'),
      command: z.string().optional().describe('新的 shell 命令'),
      missPolicy: z.enum(['run_once', 'skip']).optional().describe('新的错过策略'),
      maxRetries: z.number().optional().describe('新的最大重试次数'),
      timeoutSec: z.number().optional().describe('新的超时秒数'),
    },

    execute: async (args) => {
      try {
        const job = store.getJob(args.jobId)
        if (!job) {
          return { success: false, error: `任务不存在: ${args.jobId}` }
        }

        // 构建更新对象
        const updates: Record<string, any> = {}

        if (args.name !== undefined) updates.name = args.name
        if (args.cron !== undefined) updates.cron = args.cron
        if (args.target !== undefined) updates.target = args.target
        if (args.missPolicy !== undefined) updates.missPolicy = args.missPolicy
        if (args.maxRetries !== undefined) updates.maxRetries = args.maxRetries
        if (args.timeoutSec !== undefined) updates.timeoutMs = args.timeoutSec * 1000

        // 更新 taskConfig（合并而非覆盖）
        if (args.prompt !== undefined || args.context !== undefined) {
          const config = { ...job.taskConfig } as any
          if (args.prompt !== undefined) config.prompt = args.prompt
          if (args.context !== undefined) config.context = args.context
          updates.taskConfig = config
        }
        if (args.messageTemplate !== undefined) {
          updates.taskConfig = { messageTemplate: args.messageTemplate }
        }
        if (args.command !== undefined) {
          updates.taskConfig = { command: args.command }
        }

        // 执行更新
        const updated = store.updateJob(args.jobId, updates)
        if (!updated) {
          return { success: false, error: '更新失败' }
        }

        // 刷新 timer
        const nextRun = scheduler.onJobUpdated(updated)
        const nextRunStr = nextRun
          ? new Date(nextRun).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          : '-'

        return {
          success: true,
          output: `✅ 任务 [${updated.name}] 已更新\n📅 下次执行: ${nextRunStr}`,
        }
      } catch (error) {
        return {
          success: false,
          error: `更新失败: ${error instanceof Error ? error.message : '未知错误'}`,
        }
      }
    },
  }

  // ==================== 3. 查看任务列表 ====================

  const listCronjobs: RegisteredTool = {
    name: 'list_cronjobs',

    description: '列出所有用户创建的定时任务，包括名称、cron 表达式、启用状态、上次执行结果和下次执行时间。',

    inputSchema: {
      enabledOnly: z.boolean().optional().describe('是否只显示启用的任务，默认显示全部'),
    },

    execute: async (args) => {
      try {
        const jobs = store.listJobs(args.enabledOnly ?? false)
        if (jobs.length === 0) {
          return { success: true, output: '📋 暂无定时任务' }
        }

        const lines = jobs.map((job, i) => {
          const statusIcon = job.enabled ? '🟢' : '🔴'
          const lastRun = job.lastRunAt
            ? new Date(job.lastRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
            : '从未执行'
          const statusMap: Record<string, string> = {
            success: '✅', failed: '❌', running: '🔄', retrying: '🔄',
          }
          const lastStatus = job.lastRunStatus ? (statusMap[job.lastRunStatus] || '❓') : '-'
          const nextRun = scheduler.getNextRunTime(job)
          const nextRunStr = nextRun
            ? new Date(nextRun).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
            : '-'
          const targetDesc = job.target.startsWith('ou_') ? '👤 私聊' : '👥 群聊'

          return [
            `${i + 1}. ${statusIcon} **${job.name}**`,
            `   ID: \`${job.id}\``,
            `   Cron: \`${job.cron}\` | 类型: ${job.taskType} | ${targetDesc}`,
            `   上次: ${lastRun} ${lastStatus} | 下次: ${nextRunStr}`,
          ].join('\n')
        })

        return {
          success: true,
          output: `📋 定时任务列表（共 ${jobs.length} 个）\n\n${lines.join('\n\n')}`,
        }
      } catch (error) {
        return {
          success: false,
          error: `查询失败: ${error instanceof Error ? error.message : '未知错误'}`,
        }
      }
    },
  }

  // ==================== 4. 管理定时任务 ====================

  const manageCronjob: RegisteredTool = {
    name: 'manage_cronjob',

    description: '管理定时任务：启用(enable)、禁用(disable)、删除(delete)、手动触发(trigger)。',

    inputSchema: {
      jobId: z.string().describe('任务 ID'),
      action: z.enum(['enable', 'disable', 'delete', 'trigger']).describe('操作类型'),
    },

    execute: async (args) => {
      try {
        const { jobId, action } = args
        const job = store.getJob(jobId)
        if (!job) {
          return { success: false, error: `任务不存在: ${jobId}` }
        }

        switch (action) {
          case 'enable': {
            const updated = store.updateJob(jobId, { enabled: true })
            if (!updated) return { success: false, error: '启用失败' }
            const nextRun = scheduler.onJobUpdated(updated)
            const nextRunStr = nextRun
              ? new Date(nextRun).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
              : '-'
            return { success: true, output: `✅ 任务 [${job.name}] 已启用\n📅 下次执行: ${nextRunStr}` }
          }

          case 'disable': {
            store.updateJob(jobId, { enabled: false })
            scheduler.onJobDeleted(jobId)  // 清除 timer
            return { success: true, output: `⏸️ 任务 [${job.name}] 已禁用` }
          }

          case 'delete': {
            store.deleteJob(jobId)
            scheduler.onJobDeleted(jobId)
            return { success: true, output: `🗑️ 任务 [${job.name}] 已删除` }
          }

          case 'trigger': {
            await scheduler.triggerJob(jobId)
            return { success: true, output: `🚀 任务 [${job.name}] 已手动触发执行` }
          }

          default:
            return { success: false, error: `未知操作: ${action}` }
        }
      } catch (error) {
        return {
          success: false,
          error: `操作失败: ${error instanceof Error ? error.message : '未知错误'}`,
        }
      }
    },
  }

  // ==================== 5. 查看执行日志 ====================

  const getCronjobLogs: RegisteredTool = {
    name: 'get_cronjob_logs',

    description: '查看指定定时任务的执行日志，包括执行时间、状态、耗时、结果或错误信息。',

    inputSchema: {
      jobId: z.string().describe('任务 ID'),
      limit: z.number().optional().describe('返回条数，默认 10'),
    },

    execute: async (args) => {
      try {
        const job = store.getJob(args.jobId)
        const jobName = job?.name || args.jobId

        const logs = store.getJobLogs(args.jobId, args.limit ?? 10)
        if (logs.length === 0) {
          return { success: true, output: `📜 任务 [${jobName}] 暂无执行记录` }
        }

        const statusIcons: Record<string, string> = {
          success: '✅',
          failed: '❌',
          timeout: '⏱️',
        }

        const lines = logs.map((log, i) => {
          const icon = statusIcons[log.status] || '❓'
          const time = new Date(log.startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          const duration = `${((log.finishedAt - log.startedAt) / 1000).toFixed(1)}s`
          const attempt = log.attempt > 1 ? ` (第${log.attempt}次尝试)` : ''
          const detail = log.error
            ? `错误: ${log.error}`
            : log.result
              ? `结果: ${log.result.slice(0, 100)}${log.result.length > 100 ? '...' : ''}`
              : ''

          return `${i + 1}. ${icon} ${time} | 耗时 ${duration}${attempt}${detail ? `\n   ${detail}` : ''}`
        })

        return {
          success: true,
          output: `📜 任务 [${jobName}] 执行日志（最近 ${logs.length} 条）\n\n${lines.join('\n')}`,
        }
      } catch (error) {
        return {
          success: false,
          error: `查询失败: ${error instanceof Error ? error.message : '未知错误'}`,
        }
      }
    },
  }

  return [createCronjob, updateCronjob, listCronjobs, manageCronjob, getCronjobLogs]
}

// ─────────────────── 辅助函数 ───────────────────

/**
 * 校验任务类型对应的必填参数
 */
function validateTaskParams(taskType: UserTaskType, args: any): string | null {
  switch (taskType) {
    case 'agent_prompt':
      if (!args.prompt) return 'agent_prompt 类型必须提供 prompt 参数'
      break
    case 'feishu_notify':
      if (!args.messageTemplate) return 'feishu_notify 类型必须提供 messageTemplate 参数'
      break
    case 'custom_script':
      if (!args.command) return 'custom_script 类型必须提供 command 参数'
      break
  }
  return null
}

/**
 * 根据任务类型构建 taskConfig
 */
function buildTaskConfig(taskType: UserTaskType, args: any) {
  switch (taskType) {
    case 'agent_prompt': {
      const config: AgentPromptConfig = { prompt: args.prompt }
      if (args.context) config.context = args.context
      return config
    }
    case 'feishu_notify': {
      const config: FeishuNotifyConfig = { messageTemplate: args.messageTemplate }
      return config
    }
    case 'custom_script': {
      const config: CustomScriptConfig = { command: args.command }
      return config
    }
  }
}
