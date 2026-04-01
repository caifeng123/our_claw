import type { Module } from '../module-system/types.js'
import { CronScheduler } from '../cronjob/cron-scheduler.js'

export function createCronModule(cronScheduler: CronScheduler): Module {
  return {
    name: 'cron-scheduler',
    priority: 80,

    async onInit() {
      // CronScheduler 在构造时已 start()
      console.log('⏰ [CronModule] Scheduler initialized')
    },

    async onReady() {
      // 可在此注册需要其他服务就绪后才能执行的 cron jobs
      console.log('⏰ [CronModule] Scheduler ready')
    },

    async onShutdown() {
      cronScheduler.stop()
      console.log('⏰ [CronModule] Scheduler stopped')
    },
  }
}
