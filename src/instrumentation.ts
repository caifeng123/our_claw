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
