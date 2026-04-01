import type { Module } from '../module-system/types.js'
import { getSkillInterceptorConfig } from '../self-iteration/skill-interceptor.js'

/**
 * SelfIteration 模块 (priority=20)
 *
 * 职责：
 *   - SkillInterceptor hooks: 每次 query 拦截 Skill 调用，追加 practice sections
 *   - personal-optimizer / others-analyzer SubAgents 不在此注入，
 *     它们仅在定时任务（CronExecutor）触发自迭代时按需使用
 */
export function createSelfIterationModule(): Module {
  const interceptor = getSkillInterceptorConfig()

  return {
    name: 'self-iteration',
    priority: 20,

    // SDK Slots — 仅注入 SkillInterceptor hooks
    hooks: interceptor.hooks,
    // agents 不注入: personal-optimizer / others-analyzer 由 CronExecutor 按需传入
  }
}
