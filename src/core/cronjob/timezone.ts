/**
 * 时区工具 — 统一使用 Asia/Shanghai (UTC+8)
 *
 * 所有需要"当前几点""今天星期几"的地方都应调用这里的方法，
 * 不要直接用 new Date().getHours() / getDay()，因为它们取的是系统时区。
 */

export const TIMEZONE = 'Asia/Shanghai'

/**
 * 获取当前东八区的小时数 (0-23)
 */
export function getChinaHour(): number {
  const now = new Date()
  const chinaTime = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }))
  return chinaTime.getHours()
}

/**
 * 获取当前东八区的星期几 (0=周日, 1=周一, ..., 6=周六)
 */
export function getChinaDay(): number {
  const now = new Date()
  const chinaTime = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }))
  return chinaTime.getDay()
}

/**
 * 获取东八区的格式化日期字符串
 */
export function formatChinaDate(timestamp?: number): string {
  const date = timestamp ? new Date(timestamp) : new Date()
  return date.toLocaleDateString('zh-CN', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

/**
 * 获取东八区的格式化时间字符串
 */
export function formatChinaTime(timestamp?: number): string {
  const date = timestamp ? new Date(timestamp) : new Date()
  return date.toLocaleTimeString('zh-CN', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * 获取东八区的格式化日期时间字符串
 */
export function formatChinaDateTime(timestamp?: number): string {
  const date = timestamp ? new Date(timestamp) : new Date()
  return date.toLocaleString('zh-CN', { timeZone: TIMEZONE })
}

/**
 * 获取东八区的星期中文名
 */
export function getChinaWeekday(timestamp?: number): string {
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const date = timestamp ? new Date(timestamp) : new Date()
  const chinaTime = new Date(date.toLocaleString('en-US', { timeZone: TIMEZONE }))
  return weekdays[chinaTime.getDay()] ?? '未知'
}
