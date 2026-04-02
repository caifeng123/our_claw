import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { z } from 'zod'
import { getImageMimeType, IMAGE_MAX_FILE_SIZE, VISION_SYSTEM_PROMPT } from '../../../config/image-config.js'
import type { ContentPart } from '../engine/llm-engine.js'

const analysisCache = new Map<string, string>()

export interface AnalyzeImageDeps {
  llmEngine: {
    executeOnceLLMQuery(
      systemPrompt: string,
      userPrompt: string | ContentPart[],
      options?: { model?: string; baseUrl?: string }
    ): Promise<string>
  }
}

async function analyzeSingleImage(
  deps: AnalyzeImageDeps,
  filePath: string,
  question: string,
): Promise<{ file_path: string; success: boolean; analysis?: string; error?: string; cached?: boolean }> {
  const label = path.basename(filePath)

  if (!fs.existsSync(filePath)) {
    return { file_path: filePath, success: false, error: `File not found: ${filePath}` }
  }

  const fileBuffer = fs.readFileSync(filePath)

  if (fileBuffer.length === 0) {
    return { file_path: filePath, success: false, error: 'File is empty' }
  }
  if (fileBuffer.length > IMAGE_MAX_FILE_SIZE) {
    return { file_path: filePath, success: false, error: `File too large: ${fileBuffer.length} bytes` }
  }

  // MIME: mime 库自动识别后缀，无后缀 fallback image/jpeg
  const mimeType = getImageMimeType(filePath)

  // 缓存
  const contentHash = crypto.createHash('sha256').update(fileBuffer).digest('hex').substring(0, 16)
  const cacheKey = `${contentHash}:${question}`

  if (analysisCache.has(cacheKey)) {
    return { file_path: filePath, success: true, analysis: analysisCache.get(cacheKey), cached: true }
  }

  // base64 → data URL → vision LLM
  const base64Data = fileBuffer.toString('base64')
  const dataUrl = `data:${mimeType};base64,${base64Data}`

  const userContent: ContentPart[] = [
    { type: 'text', text: question },
    { type: 'image_url', image_url: { url: dataUrl } },
  ]

  try {
    const visionModel = process.env.VISION_MODEL || process.env.LLM_MODEL || ''
    const visionBaseUrl = process.env.VISION_BASE_URL || process.env.LLM_BASE_URL || ''

    const startTime = Date.now()
    const result = await deps.llmEngine.executeOnceLLMQuery(
      VISION_SYSTEM_PROMPT,
      userContent,
      { model: visionModel, baseUrl: visionBaseUrl }
    )

    analysisCache.set(cacheKey, result)
    return { file_path: filePath, success: true, analysis: result, cached: false }
  } catch (error: any) {
    return { file_path: filePath, success: false, error: `Image analysis failed: ${error.message}` }
  }
}

export function createAnalyzeImageTool(deps: AnalyzeImageDeps) {
  return {
    name: 'analyze_image',
    description: `Analyze one or more image files and answer questions about them. Supports all common image formats. Also works with extensionless files (e.g. img_v3_xxx from Feishu). Pass file_path for single image, or file_paths for concurrent batch analysis. Do NOT use send_image when analysis fails — report the error instead.`,
    inputSchema: {
      file_path: z.string().optional().describe('Single image file path (use this OR file_paths)'),
      file_paths: z.array(z.string()).optional().describe('Multiple image file paths for concurrent batch analysis'),
      question: z.string().optional().describe('Question about the image(s). Defaults to general description.'),
    },
    execute: async (args: Record<string, any>) => {
      const { file_path, file_paths, question = 'Please describe this image in detail.' } = args as {
        file_path?: string
        file_paths?: string[]
        question?: string
      }

      const paths: string[] = []
      if (file_paths && file_paths.length > 0) paths.push(...file_paths)
      if (file_path) paths.push(file_path)

      if (paths.length === 0) {
        return { success: false, error: 'No file path provided. Use file_path or file_paths.' }
      }


      if (paths.length === 1) {
        return analyzeSingleImage(deps, paths[0]!, question)
      }

      const results = await Promise.all(
        paths.map(p => analyzeSingleImage(deps, p, question))
      )

      const succeeded = results.filter(r => r.success).length

      return { success: succeeded > 0, total: results.length, succeeded, results }
    },
  }
}
