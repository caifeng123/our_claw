import type { Module } from '../module-system/types.js'

/**
 * FeishuTransport Module — 通信基础层
 *
 * 管理飞书 token、WebSocket 长连接、设备认证
 * 当前实现为壳模块：实际初始化仍由 index.ts 调用 startDefaultFeishuBridge()
 * 后续可逐步将 FeishuService + DeviceAuth + UserAuth 迁入
 */
export function createFeishuTransportModule(): Module {
  return {
    name: 'feishu-transport',
    priority: 5,
    hotReloadable: true,

    async onInit() {
      // 飞书连接初始化目前仍在 index.ts 中
      // 后续 Phase 可逐步迁入
      console.log('📡 [FeishuTransport] Module registered (bridge init deferred to index.ts)')
    },

    async onShutdown() {
      console.log('📡 [FeishuTransport] Shutdown')
    },
  }
}
