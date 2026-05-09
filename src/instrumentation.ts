/**
 * OTel + Langfuse + Claude Agent SDK 自动 Instrumentation
 * 必须在所有其他 import 之前加载(在 index.ts 顶部 import)
 *
 * 使用官方 @arizeai/openinference-instrumentation-claude-agent-sdk
 * 自动捕获所有 query() 调用的 agent steps、tool calls、model completions
 *
 * 关键: Node.js ESM 下 namespace 对象只读,需浅拷贝后 patch,
 * 然后导出 patched 的 query 供 claude-engine.ts 使用
 */

import dotenv from 'dotenv'
dotenv.config()

import { NodeSDK } from '@opentelemetry/sdk-node'
import { LangfuseSpanProcessor, isDefaultExportSpan } from '@langfuse/otel'
import { ClaudeAgentSDKInstrumentation } from '@arizeai/openinference-instrumentation-claude-agent-sdk'
import * as ClaudeAgentSDKModule from '@anthropic-ai/claude-agent-sdk'
import { propagateAttributes } from '@langfuse/core'

const publicKey = process.env.LANGFUSE_PUBLIC_KEY || ''
const secretKey = process.env.LANGFUSE_SECRET_KEY || ''
const baseUrl = process.env.LANGFUSE_BASE_URL || 'http://localhost:3000'

const enabled =
  process.env.LANGFUSE_ENABLED !== 'false' && !!publicKey && !!secretKey

let sdk: NodeSDK | null = null

// 创建可变副本(ESM namespace 对象只读,无法直接赋值)
const ClaudeAgentSDK = { ...ClaudeAgentSDKModule } as any

if (enabled) {
  const instrumentation = new ClaudeAgentSDKInstrumentation()
  instrumentation.manuallyInstrument(ClaudeAgentSDK)

  sdk = new NodeSDK({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey,
        secretKey,
        baseUrl,
        shouldExportSpan: ({ otelSpan }) =>
          isDefaultExportSpan(otelSpan) ||
          otelSpan.instrumentationScope.name ===
            '@arizeai/openinference-instrumentation-claude-agent-sdk',
      }),
    ],
    instrumentations: [instrumentation],
  })
  sdk.start()
  console.log(`📡 Langfuse tracing enabled (Claude Agent SDK auto-instrumentation) → ${baseUrl}`)
} else {
  console.log('ℹ️ Langfuse tracing disabled (missing keys or LANGFUSE_ENABLED=false)')
}

export const langfuseSdk = sdk

/**
 * 导出 patched 的 query 函数
 * claude-engine.ts 应从此处导入 query,以确保 instrumentation 生效
 * 当 Langfuse 禁用时,这就是原始的 query — 零影响
 */
export const query = ClaudeAgentSDK.query as typeof ClaudeAgentSDKModule.query

// ──────────────────────────────────────────────────────────────────────────
// Langfuse trace 维度聚合 helper
//
// @langfuse/core 提供了 propagateAttributes(),它通过 OTel Context 传播
// userId / sessionId / tags 等元数据到当前 span 及其所有子 span。
// LangfuseSpanProcessor.onStart 会读 Context 中的这些值,自动 set 到
// 每个新 span 的属性上,从而实现 Langfuse 控制台按 user / session 聚合。
//
// 用法:在 agent 请求入口调 withAgentTrace({ userId, sessionId }, fn)
// ──────────────────────────────────────────────────────────────────────────

export interface AgentTraceContext {
  /** 用于聚合的 user 维度,推荐使用邮箱前缀 */
  userId?: string
  /** 用于聚合的 session 维度 */
  sessionId?: string
  /** Langfuse trace tags(可选） */
  tags?: string[]
}

/**
 * 在 Langfuse user/session 上下文中执行业务逻辑。
 * 子 span(包括 Claude Agent SDK 自动 instrument 的 model / tool span)
 * 会自动继承 user.id / session.id,在 Langfuse 控制台实现按 user/session 聚合。
 *
 * Langfuse 禁用时:propagateAttributes 仍调用 fn 并返回结果,零副作用。
 *
 * @example
 * await withAgentTrace({ userId: 'kuai-long-ying', sessionId: 'sid_123' }, async () => {
 *   await claudeEngine.sendMessageStream(...)
 * })
 */
export async function withAgentTrace<T>(
  ctx: AgentTraceContext,
  fn: () => Promise<T>,
): Promise<T> {
  return propagateAttributes(
    {
      userId: ctx.userId || undefined,
      sessionId: ctx.sessionId || undefined,
      tags: ctx.tags,
    },
    () => fn(),
  ) as Promise<T>
}
