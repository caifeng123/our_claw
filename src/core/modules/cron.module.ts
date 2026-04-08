import type { Module } from '../module-system/types.js'
import { CronScheduler } from '../cronjob/cron-scheduler.js'

export function createCronModule(cronScheduler: CronScheduler): Module {
  return {
    name: 'cron-scheduler',
    priority: 80,

    async onInit() {
      console.log('⏰ [CronModule] Scheduler initialized')
    },

    async onReady() {
      // 所有模块就绪、Bridge 已注入后，才启动调度器
      // start() 会加载系统任务 + 用户任务到 TimerMap，并执行 recover 补偿
      await cronScheduler.start()
      console.log('⏰ [CronModule] Scheduler started')
    },

    async onShutdown() {
      cronScheduler.stop()
      console.log('⏰ [CronModule] Scheduler stopped')
    },
  }
}
