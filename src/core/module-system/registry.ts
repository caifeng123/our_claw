/**
 * ModuleRegistry — 唯一的模块聚合器
 *
 * 职责：收集所有 Module 的声明，在正确的时机合并或执行它们
 */

import type { Module, QueryContext, MergedQueryOptions, QueryOptionsOverrides, CanUseToolResult } from './types.js'
import type { EventHandlers } from '../agent/types/agent.js'
import { QueryContextImpl } from './query-context.js'

export class ModuleRegistry {
  private modules: Module[] = []
  private moduleNames = new Set<string>()
  private activeContexts = new Map<string, QueryContext>() // sessionId → ctx
  private initialized = false
  private ready = false

  // ════════════════════════════════════════
  // 注册阶段
  // ════════════════════════════════════════

  /**
   * 注册模块。重名立即 throw
   */
  use(module: Module): this {
    if (!module.name) {
      throw new Error('Module must have a non-empty "name" field')
    }

    if (this.moduleNames.has(module.name)) {
      throw new Error(`Module name conflict: "${module.name}" is already registered`)
    }

    this.moduleNames.add(module.name)
    this.modules.push(module)

    // 按 priority 升序排序（priority 相同则保持注册顺序）
    this.modules.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))

    console.log(`📦 [Registry] Module registered: "${module.name}" (priority=${module.priority ?? 100})`)
    return this
  }

  /**
   * 获取已注册模块列表（只读）
   */
  getModules(): readonly Module[] {
    return this.modules
  }

  /**
   * 获取指定名称的模块
   */
  getModule(name: string): Module | undefined {
    return this.modules.find(m => m.name === name)
  }

  // ════════════════════════════════════════
  // 生命周期
  // ════════════════════════════════════════

  /**
   * 初始化所有模块（按 priority 升序）
   * onInit 失败则停止启动流程
   */
  async init(): Promise<void> {
    console.log(`🔧 [Registry] Initializing ${this.modules.length} modules...`)

    for (const mod of this.modules) {
      if (mod.onInit) {
        try {
          await mod.onInit()
          console.log(`  ✅ ${mod.name} initialized`)
        } catch (error) {
          console.error(`  ❌ ${mod.name} init failed:`, error)
          throw error // 初始化严格，失败则中止
        }
      }
    }

    this.initialized = true
    console.log(`🔧 [Registry] All modules initialized`)
  }

  /**
   * 全部模块就绪通知（按 priority 升序）
   * onReady 失败不阻塞其他模块
   */
  async notifyReady(): Promise<void> {
    console.log(`🟢 [Registry] Notifying modules ready...`)

    for (const mod of this.modules) {
      if (mod.onReady) {
        try {
          await mod.onReady()
        } catch (error) {
          console.error(`  ⚠️ ${mod.name} onReady failed (non-blocking):`, error)
        }
      }
    }

    this.ready = true
    console.log(`🟢 [Registry] All modules ready`)
  }

  /**
   * 优雅关闭（按 priority **逆序**）
   * onShutdown 失败继续执行其他模块
   */
  async shutdown(): Promise<void> {
    console.log(`🛑 [Registry] Shutting down ${this.modules.length} modules...`)

    // 逆序关闭
    const reversed = [...this.modules].reverse()
    for (const mod of reversed) {
      if (mod.onShutdown) {
        try {
          await mod.onShutdown()
          console.log(`  ✅ ${mod.name} shutdown`)
        } catch (error) {
          console.error(`  ⚠️ ${mod.name} shutdown failed (continuing):`, error)
        }
      }
    }

    // 清理所有活跃的 QueryContext
    for (const ctx of this.activeContexts.values()) {
      ctx.dispose()
    }
    this.activeContexts.clear()

    console.log(`🛑 [Registry] Shutdown complete`)
  }

  // ════════════════════════════════════════
  // QueryContext 管理
  // ════════════════════════════════════════

  /**
   * 创建 QueryContext（自动清理上次残留 — 防御性兜底）
   */
  createQueryContext(sessionId: string, userMessage: string): QueryContext {
    // 场景 4: 防御性兜底 — 如果上次的 ctx 没被 dispose，在这里清理
    const existing = this.activeContexts.get(sessionId)
    if (existing && !existing.disposed) {
      existing.dispose()
    }

    const ctx = new QueryContextImpl(sessionId, userMessage)
    this.activeContexts.set(sessionId, ctx)
    return ctx
  }

  /**
   * 执行所有模块的 onBeforeQuery（按 priority 升序）
   */
  async beforeQuery(ctx: QueryContext): Promise<void> {
    for (const mod of this.modules) {
      if (mod.onBeforeQuery) {
        try {
          await mod.onBeforeQuery(ctx)
        } catch (error) {
          console.error(`  ⚠️ [${mod.name}] onBeforeQuery failed (skipping):`, error)
        }
      }
    }
  }

  /**
   * 执行所有模块的 onAfterQuery（按 priority 升序），然后自动 dispose ctx
   */
  async afterQuery(ctx: QueryContext): Promise<void> {
    for (const mod of this.modules) {
      if (mod.onAfterQuery) {
        try {
          await mod.onAfterQuery(ctx)
        } catch (error) {
          console.error(`  ⚠️ [${mod.name}] onAfterQuery failed (skipping):`, error)
        }
      }
    }

    // 场景 1: query 正常结束，清理
    ctx.dispose()
    this.activeContexts.delete(ctx.sessionId)
  }

  /**
   * 场景 2: /stop 中断
   */
  abortQuery(sessionId: string): void {
    const ctx = this.activeContexts.get(sessionId)
    if (ctx) {
      ctx.dispose()
      this.activeContexts.delete(sessionId)
    }
  }

  /**
   * 场景 3: /new 重置会话
   */
  resetSession(sessionId: string): void {
    const ctx = this.activeContexts.get(sessionId)
    if (ctx) {
      ctx.dispose()
      this.activeContexts.delete(sessionId)
    }
  }

  // ════════════════════════════════════════
  // SDK Slots 合并
  // ════════════════════════════════════════

  /**
   * 合并所有模块的 SDK Slots 声明，支持调用方动态覆盖
   *
   * @param overrides - 可选的动态追加配置（如定时任务按需注入 SubAgents）
   *   - agents: 追加 SubAgent 定义
   *   - hooks: 追加 Hook 配置
   *   - tools: 追加工具
   *   - allowedTools: 追加工具白名单
   *   - systemPromptExtension: 追加 system prompt 片段
   */
  buildQueryOptions(overrides?: QueryOptionsOverrides): MergedQueryOptions {
    const mergedHooks: Record<string, any[]> = {}
    const mergedAgents: Record<string, any> = {}
    const mergedTools: any[] = []
    const allowedToolsSet = new Set<string>()
    const promptParts: string[] = []
    const canUseToolFns: Array<{ name: string; fn: NonNullable<Module['canUseTool']> }> = []

    for (const mod of this.modules) {
      // hooks: 按 HookEvent 键合并，值数组 concat
      if (mod.hooks) {
        for (const [event, matchers] of Object.entries(mod.hooks)) {
          if (!mergedHooks[event]) mergedHooks[event] = []
          mergedHooks[event].push(...matchers)
        }
      }

      // agents: Object.assign 合并
      if (mod.agents) {
        Object.assign(mergedAgents, mod.agents)
      }

      // tools: 数组 concat
      if (mod.tools) {
        mergedTools.push(...mod.tools)
      }

      // allowedTools: 数组 concat + 去重
      if (mod.allowedTools) {
        for (const t of mod.allowedTools) {
          allowedToolsSet.add(t)
        }
      }

      // systemPromptExtension: 按 priority 顺序拼接
      if (mod.systemPromptExtension) {
        promptParts.push(mod.systemPromptExtension)
      }

      // canUseTool: 收集所有 guard
      if (mod.canUseTool) {
        canUseToolFns.push({ name: mod.name, fn: mod.canUseTool })
      }
    }

    // ─── 应用动态覆盖 ───
    if (overrides) {
      if (overrides.agents) {
        Object.assign(mergedAgents, overrides.agents)
      }
      if (overrides.hooks) {
        for (const [event, matchers] of Object.entries(overrides.hooks)) {
          if (!mergedHooks[event]) mergedHooks[event] = []
          mergedHooks[event].push(...matchers)
        }
      }
      if (overrides.tools) {
        mergedTools.push(...overrides.tools)
      }
      if (overrides.allowedTools) {
        for (const t of overrides.allowedTools) {
          allowedToolsSet.add(t)
        }
      }
      if (overrides.systemPromptExtension) {
        promptParts.push(overrides.systemPromptExtension)
      }
    }

    // 构建链式 canUseTool（任一拒绝即短路）
    let chainedCanUseTool: MergedQueryOptions['canUseTool'] = undefined
    if (canUseToolFns.length > 0) {
      chainedCanUseTool = async (toolName: string, input: any): Promise<CanUseToolResult> => {
        for (const { fn } of canUseToolFns) {
          const result = await fn(toolName, input)
          if (result.behavior === 'deny') {
            return result // 短路拒绝
          }
        }
        return { behavior: 'allow' }
      }
    }

    return {
      hooks: mergedHooks,
      agents: mergedAgents,
      canUseTool: chainedCanUseTool,
      tools: mergedTools,
      allowedTools: [...allowedToolsSet],
      systemPromptExtension: promptParts.join('\n\n'),
    }
  }

  // ════════════════════════════════════════
  // 流式事件装饰器链
  // ════════════════════════════════════════

  /**
   * 组装 wrapHandlers 装饰器链
   * 按 priority 降序包裹（priority 大的先包 = 内层）
   */
  buildHandlers(rawHandlers: EventHandlers, ctx: QueryContext): EventHandlers {
    let handlers = rawHandlers

    // 按 priority 降序（内层先包）
    const sorted = [...this.modules]
      .filter(m => m.wrapHandlers)
      .sort((a, b) => (b.priority ?? 100) - (a.priority ?? 100))

    for (const mod of sorted) {
      try {
        handlers = mod.wrapHandlers!(handlers, ctx)
      } catch (error) {
        console.error(`  ⚠️ [${mod.name}] wrapHandlers failed (using unwrapped):`, error)
      }
    }

    return handlers
  }

  // ════════════════════════════════════════
  // 热重载
  // ════════════════════════════════════════

  /**
   * 热重载指定模块
   */
  async reloadModule(moduleName: string): Promise<void> {
    const mod = this.modules.find(m => m.name === moduleName)
    if (!mod) {
      throw new Error(`Module not found: "${moduleName}"`)
    }

    if (!mod.hotReloadable) {
      throw new Error(`Module "${moduleName}" does not support hot reload`)
    }

    if (mod.onReload) {
      await mod.onReload()
    } else {
      // fallback: shutdown + init
      await mod.onShutdown?.()
      await mod.onInit?.()
    }

    console.log(`🔄 [Registry] Module "${moduleName}" reloaded`)
  }
}
