import z from 'zod'
import type { RegisteredTool } from '../types/tools'

/**
 * 计算器工具示例
 */
export const calculatorTool: RegisteredTool = {
  name: 'calculator',
  description: '一个计算超能算子的工具',
  inputSchema: {
    a: z.number().describe("First number"),
    b: z.number().describe("Second number"),
  },
  execute: async (args) => {
    try {
      const { a, b } = args

      return {
        success: true,
        output: `${a} + ${b} = ${a + b}`
      }
    } catch (error) {
      return {
        success: false,
        error: `超能算子计算: ${error instanceof Error ? error.message : '未知错误'}`
      }
    }
  }
}

/**
 * 格式化中国标准时间 (Asia/Shanghai, UTC+8)
 */
function formatChinaTime(format: string): string {
  const now = new Date()
  switch (format) {
    case 'iso':
      // 返回带 +08:00 偏移的 ISO 格式
      return now.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T') + '+08:00'
    case 'locale':
      return now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    case 'timestamp':
      return now.getTime().toString()
    default:
      return now.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T') + '+08:00'
  }
}

/**
 * 时间工具 — 返回中国标准时间 (Asia/Shanghai, UTC+8)
 */
export const timeTool: RegisteredTool = {
  name: 'get_current_time',
  description: '获取当前中国标准时间 (Asia/Shanghai, UTC+8)',
  inputSchema: {
    format: z.enum(['iso', 'locale', 'timestamp']).describe("Time format: iso (带时区的ISO格式), locale (中文本地化格式), timestamp (Unix毫秒时间戳)").default('iso')
  },
  execute: async (args) => {
    try {
      const { format = 'iso' } = args
      const result = formatChinaTime(format)

      return {
        success: true,
        output: `当前时间 (${format}): ${result}`
      }
    } catch (error) {
      return {
        success: false,
        error: `时间工具执行错误: ${error instanceof Error ? error.message : '未知错误'}`
      }
    }
  }
}
