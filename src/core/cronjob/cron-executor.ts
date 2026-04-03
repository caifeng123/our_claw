/**
 * CronExecutor V2 — 任务执行器
 *
 * 改进点：
 *   - custom_script: execSync → spawn（异步，不阻塞）
 *   - 所有任务类型支持 AbortSignal 超时取消
 *   - 通知目标支持 chat_id (oc_) 和 open_id (ou_)
 *   - 模板变量渲染（统一使用东八区时间）
 */

import { spawn } from 'child_process'
import type {
  CronJob,
  AgentPromptConfig,
  FeishuNotifyConfig,
  CustomScriptConfig,
  SelfIterationConfig,
  NotifyTarget,
} from './types.js'
import {
  formatChinaDate,
  formatChinaTime,
  formatChinaDateTime,
  getChinaWeekday,
} from './timezone.js'

/**
 * Agent 引擎接口（解耦，避免循环依赖）
 */
export interface AgentBridge {
  createSession(config: { sessionId: string; userId?: string }): any
  sendMessage(sessionId: string, message: string, userId?: string, sessionContext?: string): Promise<{ content: string }>
  deleteSession(sessionId: string): boolean
}

/**
 * 飞书消息发送接口（解耦）
 */
export interface FeishuBridge {
  sendText(target: NotifyTarget, text: string): Promise<void>
}

/**
 * 解析通知目标的 receive_id_type
 */
function resolveTargetType(target: NotifyTarget): 'chat_id' | 'open_id' {
  if (target.startsWith('ou_')) return 'open_id'
  return 'chat_id'  // oc_ 或其他默认为 chat_id
}

export class CronExecutor {
  private agentBridge: AgentBridge | null = null
  private feishuBridge: FeishuBridge | null = null

  /**
   * 延迟注入 AgentBridge（避免循环依赖）
   */
  setAgentBridge(bridge: AgentBridge): void {
    this.agentBridge = bridge
  }

  setFeishuBridge(bridge: FeishuBridge): void {
    this.feishuBridge = bridge
  }

  /**
   * 执行任务（带超时控制）
   */
  async execute(job: CronJob): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), job.timeoutMs)

    try {
      const result = await this.dispatch(job, controller.signal)
      return result
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * 按任务类型分发执行
   */
  private async dispatch(job: CronJob, signal: AbortSignal): Promise<string> {
    switch (job.taskType) {
      case 'agent_prompt':
        return this.executeAgentPrompt(job, signal)
      case 'feishu_notify':
        return this.executeFeishuNotify(job)
      case 'custom_script':
        return this.executeCustomScript(job, signal)
      case 'self_iteration':
        return this.executeSelfIteration(job)
      default:
        throw new Error(`未知任务类型: ${job.taskType}`)
    }
  }

  // ─────────────────── agent_prompt ───────────────────

  private async executeAgentPrompt(job: CronJob, signal: AbortSignal): Promise<string> {
    if (!this.agentBridge) {
      throw new Error('AgentBridge 未注入')
    }

    const config = job.taskConfig as AgentPromptConfig
    const sessionId = `cronjob_${job.id}_${Date.now()}`

    try {
      // 检查是否已被取消
      if (signal.aborted) throw new Error('任务已超时取消')

      // 创建临时 session
      this.agentBridge.createSession({ sessionId })

      // 执行 Agent，context 作为 sessionContext 注入
      const response = await this.agentBridge.sendMessage(
        sessionId,
        config.prompt,
        undefined,
        config.context,
      )

      const result = response.content

      // 发送结果到目标
      if (job.target && this.feishuBridge) {
        await this.feishuBridge.sendText(job.target, result)
      }

      return result
    } finally {
      // 销毁临时 session
      try {
        this.agentBridge.deleteSession(sessionId)
      } catch {
        // 忽略清理错误
      }
    }
  }

  // ─────────────────── feishu_notify ───────────────────

  private async executeFeishuNotify(job: CronJob): Promise<string> {
    const config = job.taskConfig as FeishuNotifyConfig

    // 渲染模板变量（统一东八区时间）
    const message = this.renderTemplate(config.messageTemplate)

    // 发送
    if (job.target && this.feishuBridge) {
      await this.feishuBridge.sendText(job.target, message)
    }

    return message
  }

  /**
   * 渲染模板变量 — 全部使用东八区时间
   */
  private renderTemplate(template: string): string {
    const dateStr = formatChinaDate()
    const timeStr = formatChinaTime()
    const weekday = getChinaWeekday()
    const datetimeStr = formatChinaDateTime()

    return template
      .replace(/\{\{date\}\}/g, dateStr)
      .replace(/\{\{time\}\}/g, timeStr)
      .replace(/\{\{weekday\}\}/g, weekday)
      .replace(/\{\{datetime\}\}/g, datetimeStr)
  }

  // ─────────────────── custom_script ───────────────────

  /**
   * 异步执行 shell 命令（spawn 替代 execSync）
   */
  private executeCustomScript(job: CronJob, signal: AbortSignal): Promise<string> {
    const config = job.taskConfig as CustomScriptConfig

    return new Promise((resolve, reject) => {
      // 检查是否已被取消
      if (signal.aborted) {
        reject(new Error('任务已超时取消'))
        return
      }

      const child = spawn('sh', ['-c', config.command], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

      // 监听 abort signal，杀掉子进程
      const onAbort = () => {
        child.kill('SIGTERM')
        // 给 500ms 优雅关闭，之后强杀
        setTimeout(() => child.kill('SIGKILL'), 500)
      }
      signal.addEventListener('abort', onAbort, { once: true })

      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort)

        if (signal.aborted) {
          reject(new Error('任务已超时取消'))
          return
        }

        if (code === 0) {
          const result = stdout.trim() || '(无输出)'

          // 发送结果
          if (job.target && this.feishuBridge) {
            this.feishuBridge.sendText(job.target, `📟 脚本执行完成:\n${result}`)
              .then(() => resolve(result))
              .catch(() => resolve(result))  // 发送失败不影响任务结果
          } else {
            resolve(result)
          }
        } else {
          reject(new Error(stderr.trim() || `进程退出码: ${code}`))
        }
      })

      child.on('error', (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      })
    })
  }

  // ─────────────────── self_iteration ───────────────────

  private async executeSelfIteration(job: CronJob): Promise<string> {
    const config = job.taskConfig as SelfIterationConfig

    try {
      // 动态导入，避免非必要依赖
      const { IterationChecker } = await import('../self-iteration/iteration-checker.js')
      const checker = new IterationChecker()
      const report = await checker.checkAndOptimize(config.skills)

      // self_iteration 的通知目标可能为空（内部日志记录即可）
      // 如果配置了 target，也发送报告
      if (job.target && this.feishuBridge) {
        await this.feishuBridge.sendText(job.target, `🔄 Skill 自迭代报告:\n${report}`)
      }

      return report
    } catch (err) {
      throw new Error(`自迭代执行失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
