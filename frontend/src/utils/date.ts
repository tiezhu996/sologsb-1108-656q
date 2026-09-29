/** 今天的日期，YYYY-MM-DD（本地时区） */
export function today(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 在某个日期上增加天数，返回 YYYY-MM-DD */
export function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00`)
  if (Number.isNaN(base.getTime())) return date
  base.setDate(base.getDate() + days)
  const y = base.getFullYear()
  const m = String(base.getMonth() + 1).padStart(2, '0')
  const d = String(base.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 母液开封后的默认有效期（天）：6 个月 */
export const STOCK_SHELF_LIFE_DAYS = 183

/** 是否已过期（按失效日期当天判断） */
export function isExpired(expireDate: string, reference = today()): boolean {
  return expireDate < reference
}

/** 距离失效还有多少天（负数表示已过期） */
export function daysUntilExpire(expireDate: string, reference = today()): number {
  const ref = new Date(`${reference}T00:00:00`)
  const end = new Date(`${expireDate}T00:00:00`)
  if (Number.isNaN(ref.getTime()) || Number.isNaN(end.getTime())) return 0
  return Math.round((end.getTime() - ref.getTime()) / 86_400_000)
}
