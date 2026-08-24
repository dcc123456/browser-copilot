/**
 * Pure scheduling math: when a task should next fire.
 *
 * Kept free of `chrome.*` and `Date.now()` so the rules are testable without
 * clock tricks. The caller supplies "now".
 *
 * @module lib/schedule
 */

import type { Schedule } from './scheduler-types'

/** Monday=0 … Sunday=6, matching `Date.getDay()` offset by one. */
export function isWeekend(date: Date): boolean {
  const day = date.getDay()
  return day === 0 || day === 6
}

export const MIN_INTERVAL_MINUTES = 1
export const MAX_INTERVAL_MINUTES = 24 * 60 // one day

/** Clamps an interval schedule into the range alarms will accept. */
export function coerceIntervalMinutes(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 60
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(n)))
}

function coerceHour(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 9
  return Math.min(23, Math.max(0, Math.round(n)))
}

function coerceMinute(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(59, Math.max(0, Math.round(n)))
}

/**
 * Normalizes stored schedule data, because a half-written or hand-edited record
 * must not be able to make the scheduler construct an invalid alarm.
 */
export function normalizeSchedule(raw: unknown): Schedule {
  if (!raw || typeof raw !== 'object') return { kind: 'daily', hour: 9, minute: 0 }
  const value = raw as Partial<Schedule>
  if (value.kind === 'interval') {
    return { kind: 'interval', minutes: coerceIntervalMinutes((value as { minutes?: unknown }).minutes) }
  }
  if (value.kind === 'weekdays') {
    const h = (value as { hour?: unknown }).hour
    const m = (value as { minute?: unknown }).minute
    return { kind: 'weekdays', hour: coerceHour(h), minute: coerceMinute(m) }
  }
  const h = (value as { hour?: unknown }).hour
  const m = (value as { minute?: unknown }).minute
  return { kind: 'daily', hour: coerceHour(h), minute: coerceMinute(m) }
}

/**
 * Returns the ms-epoch of the next firing at or after `from`, or null when the
 * schedule is not satisfiable (which none of the current kinds are, but the
 * signature leaves room).
 *
 * For daily/weekdays, the time-of-day is interpreted in the *local* timezone —
 * "10am" means 10am on this machine, which is what a user scheduling a reminder
 * means. This deliberately does not use UTC.
 */
export function nextRunAt(schedule: Schedule, from: number): number {
  if (schedule.kind === 'interval') {
    return from + coerceIntervalMinutes(schedule.minutes) * 60_000
  }

  const hour = coerceHour(schedule.hour)
  const minute = coerceMinute(schedule.minute)
  const candidate = new Date(from)
  candidate.setHours(hour, minute, 0, 0)

  // If today's time already passed, start from tomorrow.
  if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1)

  if (schedule.kind === 'weekdays') {
    while (isWeekend(candidate)) candidate.setDate(candidate.getDate() + 1)
  }

  return candidate.getTime()
}

/** Human-readable description, used in the task list and Feishu messages. */
export function describeSchedule(schedule: Schedule, locale: string = 'en'): string {
  const zh = locale.toLowerCase().startsWith('zh')
  const pad = (n: number): string => n.toString().padStart(2, '0')
  if (schedule.kind === 'interval') {
    const m = coerceIntervalMinutes(schedule.minutes)
    return zh ? `每 ${m} 分钟` : `Every ${m} min`
  }
  const hhmm = `${pad(coerceHour(schedule.hour))}:${pad(coerceMinute(schedule.minute))}`
  if (schedule.kind === 'weekdays') return zh ? `工作日 ${hhmm}` : `Weekdays ${hhmm}`
  return zh ? `每天 ${hhmm}` : `Daily ${hhmm}`
}
