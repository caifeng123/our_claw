import type { Module, QueryContext } from '../module-system/types.js'
import type { EventHandlers } from '../agent/types/agent.js'
import { TraceCollector } from '../self-iteration/trace-collector.js'

export function createTraceModule(traceCollector: TraceCollector): Module {
  return {
    name: 'trace-collector',
    priority: 90,

    wrapHandlers(inner: EventHandlers, ctx: QueryContext): EventHandlers {
      const tc = traceCollector
      const sessionId = ctx.sessionId

      // 启动 turn 级别的 timeline 记录
      tc.startTurn(sessionId, ctx.userMessage)

      return {
        ...inner,

        onToolUseStart: async (
          toolName: string,
          input?: any,
          parentToolUseId?: string | null,
          toolUseId?: string,
        ) => {
          if (toolName === 'Skill') {
            const skillName = input?.skill || input?.name || input?.skill_name || 'unknown'
            tc.addEvent(sessionId, {
              ts: Date.now(),
              type: 'skill_start',
              skill: skillName,
              toolUseId: toolUseId ?? '',
              parentToolUseId: parentToolUseId ?? null,
              input: input ?? {},
            })
          } else {
            tc.addEvent(sessionId, {
              ts: Date.now(),
              type: 'tool_start',
              tool: toolName,
              toolUseId: toolUseId ?? '',
              parentToolUseId: parentToolUseId ?? null,
              input: input ?? {},
            })
          }

          await inner.onToolUseStart?.(toolName, input, parentToolUseId, toolUseId)
        },

        onToolUseStop: async (
          toolName: string,
          result: any,
          parentToolUseId?: string | null,
          toolUseId?: string,
        ) => {
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result)

          if (toolName === 'Skill') {
            tc.addEvent(sessionId, {
              ts: Date.now(),
              type: 'skill_ready',
              toolUseId: toolUseId ?? '',
              output: resultStr,
            })
          } else {
            const status = resultStr.toLowerCase().includes('error') ? 'error' as const : 'ok' as const
            tc.addEvent(sessionId, {
              ts: Date.now(),
              type: 'tool_end',
              tool: toolName,
              toolUseId: toolUseId ?? '',
              output: resultStr,
              status,
            })
          }

          await inner.onToolUseStop?.(toolName, result, parentToolUseId, toolUseId)
        },

        onContentStop: async () => {
          await tc.finishTurn(sessionId, '')
          await inner.onContentStop?.()
        },

        onError: async (error: string) => {
          await tc.finishTurn(sessionId, `Error: ${error}`)
          await inner.onError?.(error)
        },
      }
    },

    onBeforeQuery(ctx: QueryContext) {
      // trace root span could be created here in the future
    },

    async onAfterQuery(ctx: QueryContext) {
      // trace 上报可在此完成
    },
  }
}
