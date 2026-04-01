import type { Module, QueryContext } from '../module-system/types.js'
import { MemoryDB } from '../memory/memory-db.js'
import { ConversationStore } from '../memory/conversation-store.js'

export function createMemoryModule(memoryDb: MemoryDB, conversationStore: ConversationStore): Module {
  return {
    name: 'memory',
    priority: 30,

    async onInit() {
      // MemoryDB and ConversationStore 在构造时已自初始化
      console.log('🧠 [MemoryModule] Memory systems ready')
    },

    async onBeforeQuery(ctx: QueryContext) {
      // 可在此加入 memory 检索逻辑，将结果写入 ctx.metadata
      // 当前保持和原有行为一致：memory 通过 SystemPromptBuilder 注入
    },

    async onAfterQuery(ctx: QueryContext) {
      // 未来可在此提取对话中的新记忆点
    },

    async onShutdown() {
      memoryDb.close()
      console.log('🧠 [MemoryModule] Memory shutdown complete')
    },
  }
}
