/**
 * ClaudeEngine V6.1 — 模块化重构 + Resume 容错
 *
 * 核心变化：
 *   - sendMessageStream / sendMessage 接受 MergedQueryOptions 参数
 *   - 内部不再硬编码 VisionGuard、SkillInterceptor、SubAgent 依赖
 *   - buildQueryOptions 只负责合并基础 SDK 配置 + 外部传入的 mergedOptions
 *   - Resume 失败自动降级为新对话（清除过期映射后重试）
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentResponse, EventHandlers } from '../types/agent'
import { ToolManager } from './tool-manager'
import { SessionIdStore } from './session-id-store'
import type { MergedQueryOptions } from '../../module-system/types.js'

/** 判断是否为 resume session 失败的错误 */
function isResumeSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  return msg.includes('no conversation found') || msg.includes('session')
}

export class ClaudeEngine {
  private config: {
    model: string
    env: Record<string, any>
  }
  toolManager: ToolManager

  /** SDK session_id 持久化存储 */
  private sessionIdStore: SessionIdStore

  constructor() {
    this.toolManager = new ToolManager()
    this.sessionIdStore = new SessionIdStore()
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    }

    this.config = {
      model: process.env.CLAUDE_MODEL || '',
      env,
    }
  }

  /**
   * 获取 SessionIdStore（供外部模块使用）
   */
  getSessionIdStore(): SessionIdStore {
    return this.sessionIdStore
  }

  /**
   * 构建最终 query options
   *
   * @param skipResume - 为 true 时跳过 resume（用于 resume 失败后的降级重试）
   */
  private buildQueryOptions(
    toolsConfig: Awaited<ReturnType<ToolManager['getTools']>>,
    systemPrompt?: string,
    abortController?: AbortController,
    sessionId?: string,
    mergedOptions?: MergedQueryOptions,
    skipResume?: boolean,
  ) {
    const { model, env: baseEnv } = this.config
    // ─── 合并请求级 env（多用户 cli 环境隔离） ───
    const env = mergedOptions?.env ? { ...baseEnv, ...mergedOptions.env } : baseEnv

    // ─── 合并 allowedTools ───
    const allowedTools = [
      ...toolsConfig.allowedTools,
      ...(mergedOptions?.allowedTools ?? []),
    ]
    const uniqueAllowedTools = [...new Set(allowedTools)]

    // ─── 合并 System Prompt ───
    let finalSystemPrompt = systemPrompt || ''
    if (mergedOptions?.systemPromptExtension) {
      finalSystemPrompt = finalSystemPrompt
        ? `${finalSystemPrompt}\n\n${mergedOptions.systemPromptExtension}`
        : mergedOptions.systemPromptExtension
    }

    // ─── Resume 查找（skipResume 时跳过）───
    const sdkSessionId = (!skipResume && sessionId)
      ? this.sessionIdStore.get(sessionId)
      : undefined

    // ─── 合并模块注入的 SDK Slots ───
    const agents = mergedOptions?.agents ?? {}
    const hooks = mergedOptions?.hooks ?? {}
    const canUseTool = mergedOptions?.canUseTool
    const tools = mergedOptions?.tools ?? []

    return {
      ...toolsConfig,
      allowedTools: uniqueAllowedTools,
      model,
      settingSources: ['project'] as Options['settingSources'],
      cwd: process.cwd(),
      env,
      ...(finalSystemPrompt ? { systemPrompt: finalSystemPrompt } : {}),
      agents,
      hooks,
      ...(canUseTool ? { canUseTool } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(abortController ? { abortController } : {}),
      // [RESUME] 如果已有 SDK session_id 且未跳过，用 resume 续接对话
      ...(sdkSessionId ? { resume: sdkSessionId } : {}),
    }
  }

  /**
   * 发送消息给Claude并获取响应（非流式，支持 resume）
   */
  async sendMessage(
    userMessage: string,
    systemPrompt?: string,
    sessionId?: string,
    mergedOptions?: MergedQueryOptions,
  ): Promise<AgentResponse> {
    try {
      return await this._sendMessageInner(userMessage, systemPrompt, sessionId, mergedOptions, false)
    } catch (error) {
      // Resume 失败 → 清除映射，降级为新对话重试
      if (sessionId && isResumeSessionError(error) && this.sessionIdStore.has(sessionId)) {
        console.warn(`⚠️ [ClaudeEngine] Resume 失败，清除过期 session 映射，降级为新对话: ${sessionId}`)
        this.sessionIdStore.delete(sessionId)
        return await this._sendMessageInner(userMessage, systemPrompt, sessionId, mergedOptions, true)
      }
      console.error('Claude引擎错误:', error)
      throw new Error(`Claude API调用失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  private async _sendMessageInner(
    userMessage: string,
    systemPrompt?: string,
    sessionId?: string,
    mergedOptions?: MergedQueryOptions,
    skipResume?: boolean,
  ): Promise<AgentResponse> {
    const toolsConfig = await this.toolManager.getTools()

    const response = query({
      prompt: userMessage,
      options: this.buildQueryOptions(toolsConfig, systemPrompt, undefined, sessionId, mergedOptions, skipResume),
    })

    let result = ''
    let lastAssistantContent = ''

    for await (const message of response) {
      if (message.type === 'result') {
        if (sessionId && message.session_id) {
          this.sessionIdStore.set(sessionId, message.session_id)
        }
        result += (message as any).result
      } else if (message.type === 'assistant') {
        const assistantContent = message?.message?.content
        if (assistantContent) {
          const textContent = Array.isArray(assistantContent)
            ? assistantContent.filter(c => c.type === 'text').map(c => c.text).join('')
            : String(assistantContent)
          lastAssistantContent = textContent
        }
      }
    }

    if (!result.trim() && lastAssistantContent) {
      result = lastAssistantContent
    }

    if (!result.trim()) {
      throw new Error('AI响应为空')
    }

    return { content: result }
  }

  /**
   * 流式发送消息给Claude（支持 resume + mergedOptions + 自动降级）
   */
  async sendMessageStream(
    userMessage: string,
    eventHandlers?: EventHandlers,
    systemPrompt?: string,
    abortController?: AbortController,
    sessionId?: string,
    mergedOptions?: MergedQueryOptions,
  ): Promise<string> {
    try {
      return await this._sendMessageStreamInner(
        userMessage, eventHandlers, systemPrompt, abortController, sessionId, mergedOptions, false,
      )
    } catch (error) {
      // Resume 失败 → 清除映射，降级为新对话重试
      if (sessionId && isResumeSessionError(error) && this.sessionIdStore.has(sessionId)) {
        console.warn(`⚠️ [ClaudeEngine] 流式 Resume 失败，清除过期 session 映射，降级为新对话: ${sessionId}`)
        this.sessionIdStore.delete(sessionId)
        return await this._sendMessageStreamInner(
          userMessage, eventHandlers, systemPrompt, abortController, sessionId, mergedOptions, true,
        )
      }
      // 非 resume 错误，正常抛出
      const errMsg = error instanceof Error ? error.message : String(error)
      await eventHandlers?.onError?.(errMsg)
      throw error
    }
  }

  private async _sendMessageStreamInner(
    userMessage: string,
    eventHandlers?: EventHandlers,
    systemPrompt?: string,
    abortController?: AbortController,
    sessionId?: string,
    mergedOptions?: MergedQueryOptions,
    skipResume?: boolean,
  ): Promise<string> {
    let result = ''
    let pushedContent = ''
    let allThinkingContent = ''
    let lastThinkingContent = ''
    const toolUseIdToName = new Map<string, string>()
    const toolUseIdToParent = new Map<string, string>()

    await eventHandlers?.onContentStart?.()
    const toolsConfig = await this.toolManager.getTools()

    const options = this.buildQueryOptions(
      toolsConfig, systemPrompt, abortController, sessionId, mergedOptions, skipResume,
    )
    const response = query({
      prompt: userMessage,
      options,
    })

    // 处理AI响应流（abortController.abort() 会中断此循环）
    for await (const message of response) {
      if (message.type === 'result') {
        // ====== result 消息：最终结果 ======
        const resultMsg = message as any
        const messageResult = resultMsg.result

        // [RESUME] 捕获 SDK session_id 并持久化
        if (sessionId && message.session_id) {
          this.sessionIdStore.set(sessionId, message.session_id)
        }

        if (messageResult && messageResult.trim()) {
          result = messageResult

          if (pushedContent && messageResult.startsWith(pushedContent)) {
            const delta = messageResult.slice(pushedContent.length)
            if (delta.trim()) {
              await eventHandlers?.onContentDelta?.(delta)
              pushedContent += delta
            }
          } else if (!pushedContent) {
            await eventHandlers?.onContentDelta?.(messageResult)
            pushedContent = messageResult
          } else if (messageResult.length > pushedContent.length && messageResult !== pushedContent) {
            const delta = '\n\n' + messageResult
            await eventHandlers?.onContentDelta?.(delta)
            pushedContent += delta
          }
        }

      } else if (message.type === 'assistant') {
        // ====== assistant 消息：包含 thinking / text / tool_use 块 ======
        const parentToolUseId: string | null = (message as any).parent_tool_use_id ?? null
        const isSubAgentMessage = parentToolUseId != null

        const msg = message?.message
        const assistantContent = msg?.content

        if (assistantContent && Array.isArray(assistantContent)) {
          let hasThinkingInThisMessage = false

          for (const block of assistantContent) {
            // --- thinking 块 ---
            if (block.type === 'thinking' && block.thinking) {
              if (!isSubAgentMessage) {
                hasThinkingInThisMessage = true
                allThinkingContent += block.thinking
                lastThinkingContent = block.thinking
                await eventHandlers?.onThinkingDelta?.(block.thinking)
              }
            }

            // --- tool_use 块 ---
            if (block.type === 'tool_use') {
              if (block.id && block.name) {
                toolUseIdToName.set(block.id, block.name)
                if (parentToolUseId) {
                  toolUseIdToParent.set(block.id, parentToolUseId)
                }
              }
              await eventHandlers?.onToolUseStart?.(block.name, block.input, parentToolUseId, block.id)
            }

            // --- text 块 ---
            if (block.type === 'text' && block.text) {
              if (!isSubAgentMessage) {
                await eventHandlers?.onContentDelta?.(block.text)
                pushedContent += block.text
              }
            }
          }
          if (hasThinkingInThisMessage) {
            await eventHandlers?.onThinkingStop?.()
          }
        }

      } else if (message.type === 'user') {
        // ====== user 消息：工具执行结果 ======
        const userParentToolUseId: string | null = (message as any).parent_tool_use_id ?? null
        const userMsg = message as any

        const messageContent = userMsg.message?.content
        if (Array.isArray(messageContent)) {
          for (const entry of messageContent) {
            if (entry?.type === 'tool_result' && entry?.tool_use_id) {
              const toolUseId = entry.tool_use_id
              const toolName = toolUseIdToName.get(toolUseId) || 'unknown_tool'
              const effectiveParent = toolUseIdToParent.get(toolUseId) ?? userParentToolUseId

              let resultContent: any
              if (Array.isArray(entry.content)) {
                const textParts = entry.content
                  .filter((b: any) => b.type === 'text')
                  .map((b: any) => b.text || '')
                resultContent = textParts.length > 0
                  ? textParts.join('\n')
                  : JSON.stringify(entry.content).slice(0, 500)
              } else if (typeof entry.content === 'string') {
                resultContent = entry.content
              } else {
                resultContent = entry.content
                  ? JSON.stringify(entry.content).slice(0, 500)
                  : '(tool executed, no result captured)'
              }

              await eventHandlers?.onToolUseStop?.(toolName, resultContent, effectiveParent, toolUseId)
            }
          }
        } else {
          // [FALLBACK] 旧路径
          const parentToolUseId = userMsg.parent_tool_use_id
            ?? userMsg.message?.parent_tool_use_id

          const toolUseResult = userMsg.tool_use_result
            ?? userMsg.tool_result
            ?? userMsg.message?.tool_use_result
            ?? userMsg.message?.tool_result

          if (parentToolUseId) {
            const toolName = toolUseIdToName.get(parentToolUseId) || 'unknown_tool'
            let resultContent: any = toolUseResult ?? '(tool executed, no result captured)'

            if (Array.isArray(resultContent)) {
              const textParts = resultContent
                .filter((b: any) => b.type === 'text' || b.type === 'tool_result')
                .map((b: any) => b.text || b.content || JSON.stringify(b))
              resultContent = textParts.length > 0
                ? textParts.join('\n')
                : JSON.stringify(resultContent).slice(0, 500)
            } else if (typeof resultContent === 'object' && resultContent !== null) {
              if (resultContent.content && Array.isArray(resultContent.content)) {
                const textParts = resultContent.content
                  .filter((b: any) => b.type === 'text')
                  .map((b: any) => b.text)
                resultContent = textParts.length > 0
                  ? textParts.join('\n')
                  : JSON.stringify(resultContent).slice(0, 500)
              } else if (typeof resultContent.text === 'string') {
                resultContent = resultContent.text
              } else {
                resultContent = JSON.stringify(resultContent).slice(0, 500)
              }
            }

            const effectiveParent = toolUseIdToParent.get(parentToolUseId) ?? userParentToolUseId
            await eventHandlers?.onToolUseStop?.(toolName, resultContent, effectiveParent, parentToolUseId)
          }
        }
      }
      // 其他消息类型暂不处理
    }

    // 终极兜底
    if (!result.trim() && !pushedContent.trim() && lastThinkingContent.trim()) {
      result = lastThinkingContent
      await eventHandlers?.onContentDelta?.(lastThinkingContent)
    }

    if (!result.trim() && pushedContent.trim()) {
      result = pushedContent
    }

    await eventHandlers?.onContentStop?.()
    return result
  }

  /**
   * 压缩查询内容（兼容旧接口，不使用 resume，不注入模块选项）
   */
  async compressQuery(params: { systemPrompt: string; prompt: string; maxTokens: number }): Promise<string> {
    const result = await this.sendMessage(
      params.prompt,
      params.systemPrompt,
    )
    return result.content || ''
  }

  /**
   * 执行原始Claude查询（兼容旧接口，不使用 resume）
   */
  async executeClaudeQueryRaw(systemPrompt: string, prompt: string): Promise<any> {
    return this.sendMessage(prompt, systemPrompt)
  }
}
