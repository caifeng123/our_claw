import type { AgentResponse, EventHandlers } from '../types/agent'

export interface TextContent {
  type: 'text'
  text: string
}

export interface ImageContent {
  type: 'image_url'
  image_url: { url: string }
}

export type ContentPart = TextContent | ImageContent

export interface LLMQueryOptions {
  thinking?: boolean
  json_format?: boolean
  model?: string
  baseUrl?: string
}

export class LlmEngine {
  private config: {
    baseUrl: string
    apiKey: string
    model: string
  }

  constructor() {
    const config = this.getLLMConfig()
    this.config = config
  }

  /**
   * 获取LLM配置
   */
  private getLLMConfig() {
    if (!process.env.LLM_BASE_URL || !process.env.LLM_API_KEY || !process.env.LLM_MODEL) {
      throw new Error('LLM配置缺失')
    }
    return {
      baseUrl: process.env.LLM_BASE_URL,
      apiKey: process.env.LLM_API_KEY,
      model: process.env.LLM_MODEL,
    }
  }

  /**
   * 调用模型单轮对话
   */
  public async executeOnceLLMQuery(
    systemPrompt: string,
    userPrompt: string | ContentPart[],
    options: LLMQueryOptions = {},
  ): Promise<string> {
    const startTime = Date.now()
    try {
      const effectiveModel = options.model || this.config.model || process.env.LLM_MODEL || ''
      const effectiveBaseUrl = options.baseUrl || this.config.baseUrl || process.env.LLM_BASE_URL || ''

      const response = await fetch(effectiveBaseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: effectiveModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          ...(options.thinking && { thinking: { type: 'enabled' } }),
          ...(options.json_format && { response_format: { type: 'json_object' } }),
        }),
      })
      if (!response.ok) {
        throw new Error(`API调用失败: ${response.status} ${response.statusText}`)
      }

      const data: any = await response.json()

      // 检查API响应结构
      if (data?.choices?.[0]?.message) {
        return data.choices[0].message.content
      } else {
        throw new Error(`API响应格式异常, data: ${JSON.stringify(data)}`)
      }
    } catch (error) {
      throw new Error(`API响应格式异常: ${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      console.log(`LLM API调用耗时: ${(Date.now() - startTime) / 1000}s`)
    }
  }
}
