/**
 * AgentEngine V6.0 - 模块化架构重构
 *
 * 核心变化：
 *   - 引入 ModuleRegistry，所有模块通过 registry.use() 注册
 *   - buildQueryOptions 由 Registry 自动合并，ClaudeEngine 不再硬编码模块依赖
 *   - wrapWithTraceCollector 迁移到 TraceModule.wrapHandlers
 *   - 入口文件简化为注册 + 生命周期调用
 *
 * 兼容性：对外 API 完全不变，内部组装方式从手动 wiring 改为 Module 声明式
 */

import { ClaudeEngine } from './engine/claude-engine.js'
import { LlmEngine } from './engine/llm-engine.js'
import { ToolManager } from './engine/tool-manager.js'
import { SessionManager } from './engine/session-manager.js'
import { StreamHandler } from './handlers/stream-handler.js'
import { MemoryDB } from '../memory/memory-db.js'
import { ConversationStore } from '../memory/conversation-store.js'
import { SystemPromptBuilder } from './engine/system-prompt-builder.js'
import { ContextBuilder } from './engine/context-builder.js'
import { createMemoryTools } from './tools/memory-tools.js'
import { CronScheduler } from '../cronjob/cron-scheduler.js'
import { createCronjobTools } from './tools/cronjob-tools.js'
import { calculatorTool, timeTool } from './tools/calculator.js'
import { createTavilyTools } from './tools/tavily-tools.js'
import { createLinkAnalyzeTools } from './tools/link-analyze.js'
import { registerAgentEngine } from '../agent-registry.js'
import { TraceCollector } from '../self-iteration/trace-collector.js'
import { ModuleRegistry } from '../module-system/index.js'
import type { QueryContext } from '../module-system/types.js'
import {

  createImagePipelineTools,
  createSelfIterationModule,
  createMemoryModule,
  createTraceModule,
  createBuiltinToolsModule,
  createCronModule,
  createFeishuTransportModule,
  createFeishuRenderModule,
} from '../modules/index.js'
import type {
  SessionConfig,
  AgentResponse,
  EventHandlers,
  SessionState,
} from './types/agent.js'

interface SimpleMessage {
  role: 'user' | 'assistant'
  content: string
}

export class AgentEngine {
  private claudeEngine: ClaudeEngine
  private llmEngine: LlmEngine
  private toolManager: ToolManager
  private sessionManager: SessionManager
  private streamHandler: StreamHandler
  private memoryDb: MemoryDB
  private conversationStore: ConversationStore
  private contextBuilder: ContextBuilder
  private cronScheduler: CronScheduler
  private abortControllers: Map<string, AbortController> = new Map()

  // [MODULE-SYSTEM] 模块注册中心
  readonly registry: ModuleRegistry

  // [SELF-ITERATION] Trace 采集
  private traceCollector: TraceCollector

  constructor() {
    // ─── 创建 ModuleRegistry ───
    this.registry = new ModuleRegistry()

    // ─── 存储层 ───
    this.memoryDb = new MemoryDB()
    this.conversationStore = new ConversationStore()

    // ─── 上下文层 ───
    const systemPromptBuilder = new SystemPromptBuilder(this.memoryDb)
    this.contextBuilder = new ContextBuilder(systemPromptBuilder)

    // ─── Claude 引擎层 ───
    this.claudeEngine = new ClaudeEngine()

    // ─── LLM 引擎层（用于图片分析等工具） ───
    this.llmEngine = new LlmEngine()

    // ─── 会话管理器 ───
    this.sessionManager = new SessionManager(this.conversationStore)
    this.streamHandler = new StreamHandler()

    // ─── Trace 采集器 ───
    this.traceCollector = new TraceCollector()

    // ─── 注册到全局 registry ───
    registerAgentEngine(this)

    // ─── 定时任务 ───
    this.cronScheduler = new CronScheduler()

    // ─── 工具层 ───
    this.toolManager = new ToolManager()
    this.registerBuiltinTools()
    this.toolManager.registerTools(createImagePipelineTools(this.llmEngine))
    this.claudeEngine.toolManager = this.toolManager

    // ─── 注册所有 Module ───
    this.registerModules()

    console.log('🤖 Agent引擎 V6.0 初始化完成（模块化架构 + Resume + Skill 自迭代）')
  }

  /**
   * 注册所有模块到 Registry
   */
  private registerModules(): void {
    this.registry
      .use(createFeishuTransportModule())

      .use(createSelfIterationModule())
      .use(createMemoryModule(this.memoryDb, this.conversationStore))
      .use(createBuiltinToolsModule(this.toolManager))
      .use(createCronModule(this.cronScheduler))
      .use(createFeishuRenderModule())
      .use(createTraceModule(this.traceCollector))
  }

  /**
   * 异步初始化所有模块（需在 constructor 之后调用）
   */
  async initModules(): Promise<void> {
    await this.registry.init()
    await this.registry.notifyReady()
  }

  /**
   * 注册所有内置工具
   */
  private registerBuiltinTools(): void {
    this.toolManager.registerTools([calculatorTool, timeTool])
    this.toolManager.registerTools(createTavilyTools())
    this.toolManager.registerTools(createMemoryTools(this.memoryDb))
    this.toolManager.registerTools(createCronjobTools(this.cronScheduler))
    this.toolManager.registerTools(createLinkAnalyzeTools())
  }

  // ==================== 消息处理 ====================

  /**
   * 发送消息（非流式）
   */
  async sendMessage(
    sessionId: string,
    message: string,
    userId?: string,
    sessionContext?: string,
  ): Promise<AgentResponse> {
    try {
      let session = this.sessionManager.getSession(sessionId)
      if (!session) {
        session = this.sessionManager.createSession({ sessionId, userId })
      }

      const userMessage: SimpleMessage = { role: 'user', content: message }
      this.sessionManager.addMessage(sessionId, userMessage)

      const systemPromptResult = this.contextBuilder.buildSystemPrompt()
      const finalSystemPrompt = sessionContext
        ? `${systemPromptResult.text}\n\n${sessionContext}`
        : systemPromptResult.text

      console.log(`📊 System prompt 构建完成 [session=${sessionId}]:`, {
        systemPromptTokens: systemPromptResult.stats.totalTokens,
        memoryCount: systemPromptResult.stats.memoryCount,
        hasSessionContext: !!sessionContext,
        resumeMode: true,
      })

      const response = await this.claudeEngine.sendMessage(
        message,
        finalSystemPrompt,
        sessionId,
      )

      const assistantMessage: SimpleMessage = { role: 'assistant', content: response.content }
      this.sessionManager.addMessage(sessionId, assistantMessage)

      return response
    } catch (error) {
      console.error('Agent消息处理错误:', error)
      throw new Error(`Agent处理失败: ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  /**
   * 流式发送消息 — 使用 Registry 管理 QueryContext 和装饰器链
   */
  async sendMessageStream(
    sessionId: string,
    message: string,
    userId?: string,
    eventHandlers?: EventHandlers,
    sessionContext?: string,
  ): Promise<void> {
    const abortController = new AbortController()
    this.abortControllers.set(sessionId, abortController)

    // [MODULE-SYSTEM] 创建 QueryContext
    const ctx = this.registry.createQueryContext(sessionId, message)
    ctx.abortController = abortController

    try {
      let session = this.sessionManager.getSession(sessionId)
      if (!session) {
        session = this.sessionManager.createSession({ sessionId, userId })
      }

      const userMessage: SimpleMessage = { role: 'user', content: message }
      this.sessionManager.addMessage(sessionId, userMessage)

      // [MODULE-SYSTEM] 执行所有模块的 onBeforeQuery
      await this.registry.beforeQuery(ctx)

      const systemPromptResult = this.contextBuilder.buildSystemPrompt()
      const finalSystemPrompt = sessionContext
        ? `${systemPromptResult.text}\n\n${sessionContext}`
        : systemPromptResult.text

      console.log(`📊 System prompt 构建完成(流式) [session=${sessionId}]:`, {
        systemPromptTokens: systemPromptResult.stats.totalTokens,
        memoryCount: systemPromptResult.stats.memoryCount,
        hasSessionContext: !!sessionContext,
        resumeMode: true,
      })

      // [MODULE-SYSTEM] 通过 Registry 构建装饰器链（替代手动 wrapWithTraceCollector）
      const rawHandlers = eventHandlers || this.streamHandler.getEventHandlers()
      const wrappedHandlers = this.registry.buildHandlers(rawHandlers, ctx)

      this.streamHandler.setEventHandlers(wrappedHandlers)

      // [MODULE-SYSTEM] 从 Registry 获取合并后的 SDK Slots
      const mergedOptions = this.registry.buildQueryOptions()

      const responseContent = await this.claudeEngine.sendMessageStream(
        message,
        wrappedHandlers,
        finalSystemPrompt,
        abortController,
        sessionId,
        mergedOptions,  // 传入 Registry 合并的选项
      )

      const assistantMessage: SimpleMessage = { role: 'assistant', content: responseContent }
      this.sessionManager.addMessage(sessionId, assistantMessage)

      // [MODULE-SYSTEM] 执行所有模块的 onAfterQuery（内部自动 dispose ctx）
      await this.registry.afterQuery(ctx)
    } catch (error) {
      if (abortController.signal.aborted) {
        console.log(`⏹️ 会话 ${sessionId} 已被用户中断`)
        // [MODULE-SYSTEM] 中断时也要清理 ctx
        this.registry.abortQuery(sessionId)
        return
      }
      console.error('Agent流式消息处理错误:', error)
      this.streamHandler.handleEvent({
        type: 'error',
        error: `Agent流式处理失败: ${error instanceof Error ? error.message : '未知错误'}`,
      })
      // [MODULE-SYSTEM] 异常时清理
      this.registry.abortQuery(sessionId)
    } finally {
      this.abortControllers.delete(sessionId)
    }
  }

  // ==================== 工具管理 ====================

  registerTool(options: any): void {
    this.toolManager.registerTool(options)
  }

  getToolNames(): string[] {
    return this.toolManager.getToolNames()
  }

  // ==================== 会话管理 ====================

  createSession(config: SessionConfig): SessionState {
    return this.sessionManager.createSession(config)
  }

  getSession(sessionId: string): SessionState | null {
    return this.sessionManager.getSession(sessionId)
  }

  deleteSession(sessionId: string): boolean {
    this.claudeEngine.getSessionIdStore().delete(sessionId)
    // [MODULE-SYSTEM] 清理该 session 的 QueryContext
    this.registry.resetSession(sessionId)
    return this.sessionManager.deleteSession(sessionId)
  }

  hasResumeSession(sessionId: string): boolean {
    return this.claudeEngine.getSessionIdStore().has(sessionId)
  }

  abortSession(sessionId: string): boolean {
    const controller = this.abortControllers.get(sessionId)
    if (controller) {
      controller.abort()
      this.abortControllers.delete(sessionId)
      // [MODULE-SYSTEM] 中断时清理 QueryContext
      this.registry.abortQuery(sessionId)
      return true
    }
    return false
  }

  getSessionStats(): any {
    return this.sessionManager.getSessionStats()
  }

  cleanupExpiredSessions(maxAge?: number): number {
    this.claudeEngine.getSessionIdStore().cleanup()
    return this.sessionManager.cleanupExpiredSessions(maxAge)
  }

  // ==================== 事件处理 ====================

  setEventHandlers(eventHandlers: EventHandlers): void {
    this.streamHandler.setEventHandlers(eventHandlers)
  }

  createWebSocketHandler(ws: WebSocket): EventHandlers {
    return this.streamHandler.createWebSocketHandler(ws)
  }

  createHTTPStreamHandler(write: (chunk: string) => void): EventHandlers {
    return this.streamHandler.createHTTPStreamHandler(write)
  }

  // ==================== 记忆系统 ====================

  getMemoryDb(): MemoryDB {
    return this.memoryDb
  }

  getConversationStore(): ConversationStore {
    return this.conversationStore
  }

  // ==================== CronJob ====================

  getCronScheduler(): CronScheduler {
    return this.cronScheduler
  }
}

// 导出默认实例
export const agentEngine = new AgentEngine()

export default AgentEngine
