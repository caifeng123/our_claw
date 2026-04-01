/**
 * QueryContext 实现
 *
 * 每次 query() 调用的上下文对象，管理模块间数据传递和跨回调状态追踪
 */

import { randomUUID } from 'node:crypto'
import type { QueryContext } from './types.js'

export class QueryContextImpl implements QueryContext {
  readonly queryId: string
  readonly userMessage: string
  readonly sessionId: string
  isResumed?: boolean
  abortController?: AbortController
  readonly metadata: Map<string, unknown> = new Map()

  private _disposed = false
  private moduleStates = new Map<string, unknown>()

  constructor(sessionId: string, userMessage: string = '') {
    this.queryId = randomUUID()
    this.sessionId = sessionId
    this.userMessage = userMessage
  }

  get disposed(): boolean {
    return this._disposed
  }

  getModuleState<T>(moduleName: string): T | undefined {
    return this.moduleStates.get(moduleName) as T | undefined
  }

  setModuleState<T>(moduleName: string, state: T): void {
    if (this._disposed) {
      console.warn(`[QueryContext] Attempted to set state on disposed context (module: ${moduleName})`)
      return
    }
    this.moduleStates.set(moduleName, state)
  }

  dispose(): void {
    if (this._disposed) return // 幂等
    this._disposed = true
    this.moduleStates.clear()
    this.metadata.clear()
  }
}
