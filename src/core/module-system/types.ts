/**
 * Module System — 核心类型定义
 *
 * 基于 V2 架构设计，定义 Module 接口、QueryContext、Registry 类型
 */

import type { EventHandlers } from '../agent/types/agent.js'

// ─── QueryContext ───

/**
 * 每次 query() 调用的上下文对象
 * 贯穿 onBeforeQuery → query 执行 → wrapHandlers 回调 → onAfterQuery 全过程
 */
export interface QueryContext {
  /** 本次 query 唯一 ID (UUID) */
  readonly queryId: string
  /** 用户输入的原始消息 */
  readonly userMessage: string
  /** 会话 ID（用于 SDK resume） */
  readonly sessionId: string
  /** 是否为恢复的会话 */
  isResumed?: boolean
  /** 中断控制器 */
  abortController?: AbortController
  /** 简单的模块间数据传递通道 */
  readonly metadata: Map<string, unknown>
  /** 是否已被清理（只读） */
  readonly disposed: boolean

  /** 获取指定模块的专属状态（类型安全） */
  getModuleState<T>(moduleName: string): T | undefined
  /** 设置指定模块的专属状态 */
  setModuleState<T>(moduleName: string, state: T): void
  /** 清理所有模块状态，幂等，可多次调用 */
  dispose(): void
}

// ─── SDK Slots (对齐 Claude Agent SDK Options 字段) ───

/** canUseTool 返回值 */
export interface CanUseToolResult {
  behavior: 'allow' | 'deny'
  message?: string
}

/** canUseTool 函数签名 */
export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
) => CanUseToolResult | Promise<CanUseToolResult>

// ─── Module 接口 ───

/**
 * Module 是系统的基本组成单元。
 * 每个 Module 通过声明式字段告诉 Registry 自己需要向 SDK 注入什么，
 * 以及在哪些生命周期阶段需要执行逻辑。
 */
export interface Module {
  // ─── 身份标识 ───

  /** 模块唯一名称（重名在 use() 时 throw） */
  readonly name: string
  /** 优先级，默认 100，越小越先执行 */
  readonly priority?: number

  // ─── SDK Slots（自动合并到 query Options）───

  /**
   * SDK HookEvent 的 Matcher 声明
   * 对齐 SDK 的 HookCallbackMatcher: { matcher?: string; hooks: any[] }
   */
  hooks?: Record<string, Array<{ matcher?: string; hooks: any[] }>>
  /** Sub-Agent 定义 */
  agents?: Record<string, any>
  /** 工具权限拦截 */
  canUseTool?: CanUseToolFn
  /** MCP 自定义工具 */
  tools?: any[]
  /** 工具白名单追加 */
  allowedTools?: string[]
  /** 系统 prompt 追加片段 */
  systemPromptExtension?: string
  /** 额外环境变量（多用户 cli 环境隔离） */
  env?: Record<string, string>

  // ─── 流式事件装饰器（可选）───

  /** 包装 EventHandlers，返回增强后的 handlers */
  wrapHandlers?(handlers: EventHandlers, ctx: QueryContext): EventHandlers

  // ─── 自定义生命周期回调（5 个）───

  /** 模块初始化 */
  onInit?(): Promise<void> | void
  /** 全部模块初始化完成后 */
  onReady?(): Promise<void> | void
  /** 优雅关闭 */
  onShutdown?(): Promise<void> | void
  /** 每次 query 前 */
  onBeforeQuery?(ctx: QueryContext): Promise<void> | void
  /** 每次 query 后 */
  onAfterQuery?(ctx: QueryContext): Promise<void> | void

  // ─── 热重载（可选）───

  /** 是否支持热重载 */
  hotReloadable?: boolean
  /** 热重载时调用，替代 shutdown + init */
  onReload?(): Promise<void> | void
}

// ─── BuildQueryOptions 输出 & 动态覆盖 ───

export interface MergedQueryOptions {
  hooks: Record<string, any[]>
  agents: Record<string, any>
  canUseTool?: (toolName: string, input: any) => any
  tools: any[]
  allowedTools: string[]
  systemPromptExtension: string
  /** 额外环境变量，会合并到 Agent 进程的 env 中（用于多用户 cli 环境隔离） */
  env?: Record<string, string>
}

/**
 * 动态覆盖参数，调用方按需传入
 * 所有字段可选，传入的会追加/覆盖到 Registry 合并结果上
 */
export interface QueryOptionsOverrides {
  /** 追加 agents（如定时任务的 personal-optimizer） */
  agents?: Record<string, any>
  /** 追加 hooks */
  hooks?: Record<string, any[]>
  /** 追加 tools */
  tools?: any[]
  /** 追加 allowedTools */
  allowedTools?: string[]
  /** 追加 systemPromptExtension */
  systemPromptExtension?: string
  /** 额外环境变量（多用户 cli 环境隔离） */
  env?: Record<string, string>
}
