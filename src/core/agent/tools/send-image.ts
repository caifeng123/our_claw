import * as fs from 'fs'
import { z } from 'zod'
import { isUploadable } from '../../../config/image-config.js'
import { getFeishuUploader, getActiveRenderer } from './image-pipeline-context.js'

export function createSendImageTool() {
  return {
    name: 'send_image',
    description: `Send an image to the user by uploading it to Feishu and displaying it in the chat card. Only use this when the user explicitly asks to see an image or when you need to show visual content. Do NOT use this as a fallback when analyze_image fails.`,
    inputSchema: {
      file_path: z.string().describe('Absolute path to the image file to send'),
      alt_text: z.string().optional().describe('Alt text description for the image'),
    },
    execute: async (args: Record<string, any>) => {
      const { file_path, alt_text = 'Image' } = args as { file_path: string; alt_text?: string }


      if (!fs.existsSync(file_path)) {
        return { success: false, error: `File not found: ${file_path}` }
      }

      if (!isUploadable(file_path)) {
        return { success: false, error: `Image format not directly uploadable. Supported: jpg, jpeg, png, gif, bmp, webp, ico` }
      }

      const uploader = getFeishuUploader()
      if (!uploader) {
        return { success: false, error: 'Feishu uploader not available.' }
      }

      const renderer = getActiveRenderer()
      if (!renderer) {
        return { success: false, error: 'No active card renderer.' }
      }

      try {
        const imageKey = await uploader.uploadImage(file_path)

        renderer.registerImage(imageKey, alt_text)
        return { success: true, image_key: imageKey, message: 'Image sent to user successfully.' }
      } catch (error: any) {
        return { success: false, error: `Failed to upload image: ${error.message}` }
      }
    },
  }
}
