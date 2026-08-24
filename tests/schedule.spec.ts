import { describe, expect, it } from 'vitest'
import {
  coerceIntervalMinutes,
  describeSchedule,
  isWeekend,
  nextRunAt,
  normalizeSchedule,
} from '../src/lib/schedule'

describe('nextRunAt · daily', () => {
  it('picks today when the time is still ahead', () => {
    // Mon 2024-01-01 08:00 local; target 10:00 same day.
    const from = new Date(2024, 0, 1, 8, 0).getTime()
    const next = new Date(nextRunAt({ kind: 'daily', hour: 10, minute: 0 }, from))
    expect(next.getFullYear()).toBe(2024)
    expect(next.getMonth()).toBe(0)
    expect(next.getDate()).toBe(1)
    expect(next.getHours()).toBe(10)
    expect(next.getMinutes()).toBe(0)
  })

  it('rolls to tomorrow when the time has passed', () => {
    const from = new Date(2024, 0, 1, 11, 0).getTime()
    const next = new Date(nextRunAt({ kind: 'daily', hour: 10, minute: 0 }, from))
    expect(next.getDate()).toBe(2)
    expect(next.getHours()).toBe(10)
  })

  it('rolls to tomorrow at an exact match (fires "at or after from")', () => {
    // 10:00 exactly is not strictly after, so the next fire is tomorrow.
    const from = new Date(2024, 0, 1, 10, 0, 0).getTime()
    const next = new Date(nextRunAt({ kind: 'daily', hour: 10, minute: 0 }, from))
    expect(next.getDate()).toBe(2)
  })
})

describe('nextRunAt · weekdays', () => {
  it('skips Saturday and Sunday', () => {
    // Friday 2024-01-05 at 18:00; next weekday 10:00 is Monday the 8th.
    const fri = new Date(2024, 0, 5, 18, 0).getTime()
    const next = new Date(nextRunAt({ kind: 'weekdays', hour: 10, minute: 0 }, fri))
    expect(next.getDay()).toBe(1) // Monday
    expect(next.getDate()).toBe(8)
  })

  it('returns the same weekday when time is ahead', () => {
    // Wed 2024-01-03 08:00 -> 10:00 same day.
    const wed = new Date(2024, 0, 3, 8, 0).getTime()
    const next = new Date(nextRunAt({ kind: 'weekdays', hour: 10, minute: 0 }, wed))
    expect(next.getDay()).toBe(3)
    expect(next.getDate()).toBe(3)
  })

  it('skips a weekend landing two days out from Friday late', () => {
    const fri = new Date(2024, 0, 5, 23, 30).getTime()
    const next = new Date(nextRunAt({ kind: 'weekdays', hour: 9, minute: 0 }, fri))
    expect(next.getDay()).toBe(1)
  })
})

describe('nextRunAt · interval', () => {
  it('adds the minutes to "now"', () => {
    const from = new Date(2024, 0, 1, 12, 0).getTime()
    const next = nextRunAt({ kind: 'interval', minutes: 30 }, from)
    expect(next - from).toBe(30 * 60_000)
  })
})

describe('isWeekend', () => {
  it('identifies Saturday and Sunday', () => {
    // Jan 6 2024 is a Saturday, Jan 7 a Sunday.
    expect(isWeekend(new Date(2024, 0, 6))).toBe(true)
    expect(isWeekend(new Date(2024, 0, 7))).toBe(true)
    expect(isWeekend(new Date(2024, 0, 8))).toBe(false) // Mon
  })
})

describe('normalizeSchedule', () => {
  it('defaults garbage to daily 09:00', () => {
    expect(normalizeSchedule(null)).toEqual({ kind: 'daily', hour: 9, minute: 0 })
    expect(normalizeSchedule('nope')).toEqual({ kind: 'daily', hour: 9, minute: 0 })
  })

  it('clamps hours and minutes', () => {
    expect(normalizeSchedule({ kind: 'daily', hour: 99, minute: 99 })).toEqual({
      kind: 'daily',
      hour: 23,
      minute: 59,
    })
    expect(normalizeSchedule({ kind: 'daily', hour: -5, minute: -5 })).toEqual({
      kind: 'daily',
      hour: 0,
      minute: 0,
    })
  })

  it('clamps interval minutes to at least 1', () => {
    expect(normalizeSchedule({ kind: 'interval', minutes: 0 })).toEqual({
      kind: 'interval',
      minutes: 1,
    })
    expect(normalizeSchedule({ kind: 'interval', minutes: 999999 })).toEqual({
      kind: 'interval',
      minutes: 24 * 60,
    })
  })
})

describe('coerceIntervalMinutes', () => {
  it('handles non-numeric input', () => {
    expect(coerceIntervalMinutes('abc')).toBe(60)
    expect(coerceIntervalMinutes(undefined)).toBe(60)
  })
})

describe('describeSchedule', () => {
  it('describes in English and Chinese', () => {
    expect(describeSchedule({ kind: 'daily', hour: 10, minute: 0 }, 'en')).toBe('Daily 10:00')
    expect(describeSchedule({ kind: 'daily', hour: 10, minute: 0 }, 'zh-CN')).toBe('每天 10:00')
    expect(describeSchedule({ kind: 'weekdays', hour: 9, minute: 30 }, 'en')).toContain('Weekdays')
    expect(describeSchedule({ kind: 'interval', minutes: 45 }, 'en')).toContain('45')
  })
})
