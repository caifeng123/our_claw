import type { Module } from '../module-system/types.js'

/**
 * FeishuRender Module — 消息渲染层
 *
 * 消费流式事件，驱动 StreamingCardRenderer / AI 修复重发 / 卡片状态管理
 * 当前为壳模块：wrapHandlers 由 FeishuAgentBridge 直接处理
 * 后续可将渲染逻辑迁入 wrapHandlers
 */
export function createFeishuRenderModule(): Module {
  return {
    name: 'feishu-render',
    priority: 85,
    hotReloadable: true,

    async onInit() {
      console.log('🎨 [FeishuRender] Module registered')
    },
  }
}
