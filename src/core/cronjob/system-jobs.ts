/**
 * 系统内置任务定义
 *
 * 系统任务在代码中硬编码，不存入 cronjobs.json。
 * Scheduler 启动时将它们和用户任务一起加载到 TimerMap。
 *
 * 当前没有系统内置任务（self_iteration 已废弃，由 Langfuse 链路替代）。
 */

import type { CronJob } from './types.js'

/**
 * 获取所有系统内置任务
 */
export function getSystemJobs(): CronJob[] {
  return []
}
