/**
 * Entry Point V6.1 — 模块化架构（精简版）
 *
 * 职责：
 *   1. HTTP 路由挂载
 *   2. 飞书服务初始化
 *   3. 模块系统生命周期 (init → ready → shutdown)
 *   4. 进程信号处理
 */

import './env-setup.js'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import agentRouter from './routes/agent.js'
import feishuRouter from './routes/feishu.js'
import memoryRouter from './routes/memory.js'
import { getFeishuConfig, validateFeishuConfig } from './config/feishu.js'
import { startDefaultFeishuBridge, stopDefaultFeishuBridge } from './services/feishu/feishu-agent-bridge.js'
import { agentEngine } from './core/agent/index.js'
import { getDefaultFeishuAgentBridge } from './services/feishu/feishu-agent-bridge.js'

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000

// ─── HTTP 应用 ───
const app = new Hono()

app.use('*', logger())
app.use('*', cors())

app.get('/', (c) => c.json({ message: 'cf_claw API Server', status: 'running' }))
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

app.route('/api/agent', agentRouter)
app.route('/api/feishu', feishuRouter)
app.route('/api/memory', memoryRouter)

// ════════════════════════════════════════
// 飞书服务
// ════════════════════════════════════════

async function initializeFeishuService(): Promise<boolean> {
  const feishuConfig = getFeishuConfig()
  const validation = validateFeishuConfig(feishuConfig)

  if (!validation.valid) {
    console.warn('⚠️ 飞书配置验证失败:', validation.errors.join(', '))
    return false
  }

  if (!feishuConfig.enabled) {
    console.log('ℹ️ 飞书集成已禁用，跳过初始化')
    return false
  }

  console.log('🚀 初始化飞书Agent桥接服务...')

  try {
    const success = await startDefaultFeishuBridge({
      feishu: {
        appId: feishuConfig.appId,
        appSecret: feishuConfig.appSecret,
      },
      ...feishuConfig.bridge,
    })

    if (!success) {
      console.error('❌ 飞书Agent桥接服务启动失败')
    }

    return success
  } catch (error) {
    console.error('❌ 飞书服务初始化失败:', error)
    return false
  }
}

// ════════════════════════════════════════
// 优雅关闭
// ════════════════════════════════════════

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\n🛑 收到${signal}信号，正在优雅关闭...`)

  // [MODULE-SYSTEM] 通过 Registry 关闭所有模块（包括 CronScheduler）
  await agentEngine.registry.shutdown()

  await stopDefaultFeishuBridge()
  console.log('✅ 服务已关闭')
  process.exit(0)
}

// ════════════════════════════════════════
// 启动
// ════════════════════════════════════════

async function main(): Promise<void> {
  // 1. 飞书服务初始化
  await initializeFeishuService()

  // 1.5 注入 CronExecutor 的 AgentBridge 和 FeishuBridge
  const cronExecutor = agentEngine.getCronScheduler().getExecutor()
  cronExecutor.setAgentBridge({
    createSession: (config) => agentEngine.createSession(config),
    sendMessage: (sessionId, message, userId, sessionContext) =>
      agentEngine.sendMessage(sessionId, message, userId, sessionContext),
    deleteSession: (sessionId) => agentEngine.deleteSession(sessionId),
  })

  const feishuBridge = getDefaultFeishuAgentBridge()
  if (feishuBridge) {
    cronExecutor.setFeishuBridge({
      sendText: async (target, text) => {
        if (target.startsWith('ou_')) {
          // 个人消息：通过飞书 open_id 发送
          await feishuBridge.sendMessageByOpenId(target, text)
        } else {
          // 群聊消息：通过 chat_id 发送
          await feishuBridge.sendMessageToChat(target, text)
        }
      },
    })
    console.log('✅ CronExecutor bridges injected (Agent + Feishu)')
  } else {
    console.warn('⚠️ FeishuBridge not available, feishu_notify tasks will fail')
  }

  // 2. [MODULE-SYSTEM] 模块异步初始化（onInit → onReady）
  await agentEngine.initModules()

  // 3. HTTP 服务
  console.log(`🚀 cf_claw server starting on port ${PORT}...`)

  process.on('SIGINT', () => gracefulShutdown('SIGINT'))
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))

  // 4. 通知 Launcher 子进程已就绪
  if (process.send) {
    process.send({ type: 'ready' })
    console.log('📤 已发送 ready 信号给 Launcher')
  }
}

main().catch((error) => {
  console.error('❌ 服务启动失败:', error)
  process.exit(1)
})

export default { port: PORT, fetch: app.fetch }
