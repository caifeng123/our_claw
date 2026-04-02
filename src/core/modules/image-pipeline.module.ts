import { createAnalyzeImageTool, type AnalyzeImageDeps } from '../agent/tools/analyze-image.js'
import { createSendImageTool } from '../agent/tools/send-image.js'

/**
 * 创建图片管道工具列表
 */
export function createImagePipelineTools(
  llmEngine: AnalyzeImageDeps['llmEngine'],
) {
  return [
    createAnalyzeImageTool({ llmEngine }),
    createSendImageTool(),
  ]
}
