import type { Module } from '../module-system/types.js'
import { DEFAULT_ALLOWED_TOOLS, ToolManager } from '../agent/engine/tool-manager.js'

/**
 * BuiltinTools Module — 纯 SDK Slots 声明
 * 将 ToolManager 注册的工具和白名单以 Module 形式声明
 */
export function createBuiltinToolsModule(toolManager: ToolManager): Module {
  return {
    name: 'builtin-tools',
    priority: 50,
    allowedTools: [...DEFAULT_ALLOWED_TOOLS],

    // tools 通过 getTools() 在 buildQueryOptions 时动态获取
    // 保持和原有逻辑兼容
  }
}
