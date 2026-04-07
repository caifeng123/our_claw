import * as fs from 'fs'
import { z } from 'zod'
import { isUploadable, isHttpUrl } from '../../../config/image-config.js'
import { getFeishuUploader, getActiveRenderer } from './image-pipeline-context.js'

export function createSendImageTool() {
  return {
    name: 'send_image',
    description: `Send one or more images to the user by uploading them to Feishu and displaying in the chat card. Supports both local file paths and HTTPS URLs. Only use this when the user explicitly asks to see an image or when you need to show visual content. Do NOT use this as a fallback when analyze_image fails.`,
    inputSchema: {
      file_paths: z
        .array(z.string())
        .min(1)
        .describe('Array of absolute local file paths or HTTPS URLs of images to send'),
      alt_text: z.string().optional().describe('Alt text description shared by all images'),
    },
    execute: async (args: Record<string, any>) => {
      const { file_paths, alt_text = 'Image' } = args as {
        file_paths: string[]
        alt_text?: string
      }

      // ====== 预校验 ======
      for (const fp of file_paths) {
        if (!isHttpUrl(fp) && !fs.existsSync(fp)) {
          return { success: false, error: `File not found: ${fp}` }
        }
        if (!isUploadable(fp)) {
          return {
            success: false,
            error: `Image format not directly uploadable for: ${fp}. Supported: jpg, jpeg, png, gif, bmp, webp, ico`,
          }
        }
      }

      const uploader = getFeishuUploader()
      if (!uploader) {
        return { success: false, error: 'Feishu uploader not available.' }
      }

      const renderer = getActiveRenderer()
      if (!renderer) {
        return { success: false, error: 'No active card renderer.' }
      }

      // ====== 并发上传 ======
      const uploadTasks = file_paths.map(async (fp): Promise<{ file_path: string; image_key: string }> => {
        const imageKey = isHttpUrl(fp)
          ? await uploader.uploadImageFromUrl(fp)
          : await uploader.uploadImage(fp)
        return { file_path: fp, image_key: imageKey }
      })

      const results = await Promise.allSettled(uploadTasks)

      const succeeded: Array<{ file_path: string; image_key: string }> = []
      const failed: Array<{ file_path: string; error: string }> = []

      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          succeeded.push(r.value)
          renderer.registerImage(r.value.image_key, alt_text)
        } else {
          const reason = r.reason instanceof Error ? r.reason.message : String(r.reason)
          failed.push({ file_path: file_paths[i] ?? `unknown_index_${i}`, error: reason })
        }
      })

      if (failed.length === file_paths.length) {
        return {
          success: false,
          error: `All ${failed.length} image(s) failed to upload.`,
          failed,
        }
      }

      return {
        success: true,
        total: file_paths.length,
        succeeded_count: succeeded.length,
        failed_count: failed.length,
        image_keys: succeeded.map((s) => s.image_key),
        failed: failed.length > 0 ? failed : undefined,
        message: `${succeeded.length}/${file_paths.length} image(s) sent successfully.`,
      }
    },
  }
}
