/**
 * 系统内置任务定义
 *
 * 系统任务在代码中硬编码，不存入 cronjobs.json。
 * Scheduler 启动时将它们和用户任务一起加载到 TimerMap。
 */

import type { CronJob, SelfIterationConfig } from './types.js'

/**
 * 获取所有系统内置任务
 */
export function getSystemJobs(): CronJob[] {
  return [
    createSelfIterationJob(),
  ]
}

/**
 * Skill 自迭代任务
 * 每天凌晨 0:10 执行，扫描所有 Skill 的前一天 trace 进行自动优化
 *
 * 为什么是 0:10 而非 0:00？
 *   0:00 触发时日期已翻到新一天，而 trace 文件以日期命名（YYYY-MM-DD.jsonl），
 *   需要查找的是前一天的 trace。0:10 留出缓冲，确保前一天的 trace 已完整写入。
 */
function createSelfIterationJob(): CronJob {
  const config: SelfIterationConfig = {
    skills: 'all',
  }

  return {
    // 定义层
    id: '__system_self_iteration__',
    name: 'Skill 自迭代优化',
    cron: '10 0 * * *',
    taskType: 'self_iteration',
    taskConfig: config,
    target: '',  // self_iteration 的结果由 executor 内部处理推送
    createdAt: 0,

    // 配置层
    enabled: true,
    once: false,
    missPolicy: 'skip',       // 自迭代错过就跳过，不补
    maxRetries: 1,             // 最多重试 1 次
    retryDelayMs: 120_000,
    timeoutMs: 300_000,        // 5 分钟超时

    // 运行层
    lastRunAt: null,
    lastRunStatus: null,
    nextRunAt: null,
    retryCount: 0,

    // 标记
    system: true,
  }
}
