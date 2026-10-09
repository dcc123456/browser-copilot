import { describe, expect, it } from 'vitest'
import {
  coerceIntervalMinutes,
  coerceOnceAt,
  describeSchedule,
  isWeekend,
  nextRunAt,
  normalizeSchedule,
} from '../src/lib/schedule'

describe('nextRunAt · daily', () => {
  it('picks today when the time is still ahead', () => {
    // Mon 2024-01-01 08:00 local; target 10:00 same day.
    const from = new Date(2024, 0, 1, 8, 0).getTime()
    const next = new Date(nextRunAt({ kind: 'daily', hour: 10, minute: 0 }, from) as number)
    expect(next.getFullYear()).toBe(2024)
    expect(next.getMonth()).toBe(0)
    expect(next.getDate()).toBe(1)
    expect(next.getHours()).toBe(10)
    expect(next.getMinutes()).toBe(0)
  })

  it('rolls to tomorrow when the time has passed', () => {
    const from = new Date(2024, 0, 1, 11, 0).getTime()
    const next = new Date(nextRunAt({ kind: 'daily', hour: 10, minute: 0 }, from) as number)
    expect(next.getDate()).toBe(2)
    expect(next.getHours()).toBe(10)
  })

  it('rolls to tomorrow at an exact match (fires "at or after from")', () => {
    // 10:00 exactly is not strictly after, so the next fire is tomorrow.
    const from = new Date(2024, 0, 1, 10, 0, 0).getTime()
    const next = new Date(nextRunAt({ kind: 'daily', hour: 10, minute: 0 }, from) as number)
    expect(next.getDate()).toBe(2)
  })
})

describe('nextRunAt · weekdays', () => {
  it('skips Saturday and Sunday', () => {
    // Friday 2024-01-05 at 18:00; next weekday 10:00 is Monday the 8th.
    const fri = new Date(2024, 0, 5, 18, 0).getTime()
    const next = new Date(nextRunAt({ kind: 'weekdays', hour: 10, minute: 0 }, fri) as number)
    expect(next.getDay()).toBe(1) // Monday
    expect(next.getDate()).toBe(8)
  })

  it('returns the same weekday when time is ahead', () => {
    // Wed 2024-01-03 08:00 -> 10:00 same day.
    const wed = new Date(2024, 0, 3, 8, 0).getTime()
    const next = new Date(nextRunAt({ kind: 'weekdays', hour: 10, minute: 0 }, wed) as number)
    expect(next.getDay()).toBe(3)
    expect(next.getDate()).toBe(3)
  })

  it('skips a weekend landing two days out from Friday late', () => {
    const fri = new Date(2024, 0, 5, 23, 30).getTime()
    const next = new Date(nextRunAt({ kind: 'weekdays', hour: 9, minute: 0 }, fri) as number)
    expect(next.getDay()).toBe(1)
  })
})

describe('nextRunAt · interval', () => {
  it('adds the minutes to "now"', () => {
    const from = new Date(2024, 0, 1, 12, 0).getTime()
    const next = nextRunAt({ kind: 'interval', minutes: 30 }, from) as number
    expect(next - from).toBe(30 * 60_000)
  })
})

describe('nextRunAt · weekly', () => {
  it('picks the next selected weekday after a non-selected day', () => {
    // Mon 2024-01-01 08:00; selected Wed + Fri at 10:00 -> Wed Jan 3.
    const mon = new Date(2024, 0, 1, 8, 0).getTime()
    const next = new Date(
      nextRunAt({ kind: 'weekly', days: [3, 5], hour: 10, minute: 0 }, mon) as number,
    )
    expect(next.getDay()).toBe(3)
    expect(next.getDate()).toBe(3)
    expect(next.getHours()).toBe(10)
  })

  it('rolls to the following week when all selected days passed', () => {
    // Fri 2024-01-05 18:00; selected Mon at 09:00 -> Mon Jan 8.
    const fri = new Date(2024, 0, 5, 18, 0).getTime()
    const next = new Date(
      nextRunAt({ kind: 'weekly', days: [1], hour: 9, minute: 0 }, fri) as number,
    )
    expect(next.getDay()).toBe(1)
    expect(next.getDate()).toBe(8)
  })

  it('can select Sunday', () => {
    // Sat 2024-01-06 10:00; selected Sunday at 09:00 -> Sun Jan 7.
    const sat = new Date(2024, 0, 6, 10, 0).getTime()
    const next = new Date(
      nextRunAt({ kind: 'weekly', days: [0], hour: 9, minute: 0 }, sat) as number,
    )
    expect(next.getDay()).toBe(0)
    expect(next.getDate()).toBe(7)
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

  it('normalizes weekly days (dedupe, sort, drop out-of-range)', () => {
    expect(
      normalizeSchedule({ kind: 'weekly', days: [5, 3, 5, 9, -1], hour: 10, minute: 0 }),
    ).toEqual({ kind: 'weekly', days: [3, 5], hour: 10, minute: 0 })
  })

  it('falls back to daily when weekly has no valid days', () => {
    expect(normalizeSchedule({ kind: 'weekly', days: [], hour: 8, minute: 0 })).toEqual({
      kind: 'daily',
      hour: 8,
      minute: 0,
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

  it('lists selected weekly days in Monday-first order', () => {
    const desc = describeSchedule({ kind: 'weekly', days: [0, 3, 5], hour: 9, minute: 0 }, 'en')
    expect(desc).toBe('Wed, Fri, Sun 09:00')
    expect(describeSchedule({ kind: 'weekly', days: [1, 3, 5], hour: 9, minute: 0 }, 'zh-CN')).toBe(
      '每周一、周三、周五 09:00',
    )
  })
})

describe('coerceOnceAt', () => {
  it('accepts a number and a numeric string', () => {
    expect(coerceOnceAt(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(coerceOnceAt('1700000000000')).toBe(1_700_000_000_000)
  })

  it('reads a bare local stamp as local time, not UTC', () => {
    const at = coerceOnceAt('2026-11-02T20:30')
    expect(at).toBeDefined()
    const when = new Date(at as number)
    expect(when.getFullYear()).toBe(2026)
    expect(when.getMonth()).toBe(10)
    expect(when.getDate()).toBe(2)
    expect(when.getHours()).toBe(20)
    expect(when.getMinutes()).toBe(30)
  })

  it('honors an explicit UTC marker as written', () => {
    const local = coerceOnceAt('2026-11-02T20:30')
    const utc = coerceOnceAt('2026-11-02T20:30:00Z')
    expect(local).toBeDefined()
    expect(utc).toBeDefined()
    // The two differ by exactly this machine's offset at that instant, which is
    // why the tool tells the model never to send a trailing "Z".
    const offsetMs = -new Date('2026-11-02T20:30:00Z').getTimezoneOffset() * 60_000
    expect(utc! - local!).toBe(offsetMs)
  })

  it('rejects garbage rather than guessing an instant', () => {
    expect(coerceOnceAt(undefined)).toBeUndefined()
    expect(coerceOnceAt('')).toBeUndefined()
    expect(coerceOnceAt('tonight')).toBeUndefined()
    expect(coerceOnceAt(Number.NaN)).toBeUndefined()
    expect(coerceOnceAt({})).toBeUndefined()
  })
})

describe('nextRunAt · once', () => {
  it('fires at the exact instant when it is still ahead', () => {
    const from = Date.now()
    const at = from + 3_600_000
    expect(nextRunAt({ kind: 'once', at }, from)).toBe(at)
  })

  it('returns null once the instant has passed', () => {
    const from = Date.now()
    expect(nextRunAt({ kind: 'once', at: from - 1 }, from)).toBeNull()
    // Exactly now counts as gone: the next fire must not repeat a one-shot.
    expect(nextRunAt({ kind: 'once', at: from }, from)).toBeNull()
  })
})

describe('normalizeSchedule · once', () => {
  it('keeps a one-shot instant instead of folding it into the daily fallback', () => {
    const normalized = normalizeSchedule({ kind: 'once', at: '2026-11-02T20:30' })
    expect(normalized.kind).toBe('once')
    // The highest-risk regression in this feature: a garbage or dropped instant
    // becoming "Daily 09:00" would re-publish the draft every single day.
    expect(normalized).not.toEqual({ kind: 'daily', hour: 9, minute: 0 })
    const at = (normalized as { kind: 'once'; at: number }).at
    expect(new Date(at).getHours()).toBe(20)
  })

  it('accepts a numeric string instant', () => {
    expect(normalizeSchedule({ kind: 'once', at: '1700000000000' })).toEqual({
      kind: 'once',
      at: 1_700_000_000_000,
    })
  })

  it('degrades an unparseable instant to manual, never to a recurring schedule', () => {
    for (const raw of [
      { kind: 'once' },
      { kind: 'once', at: 'soon' },
      { kind: 'once', at: null },
    ]) {
      expect(normalizeSchedule(raw)).toEqual({ kind: 'none' })
    }
  })
})

describe('describeSchedule · once', () => {
  const at = new Date(2026, 10, 2, 20, 30).getTime()

  it('shows the local date and time in both languages', () => {
    expect(describeSchedule({ kind: 'once', at }, 'en')).toContain('One-time')
    expect(describeSchedule({ kind: 'once', at }, 'en')).toContain('11/02/2026 20:30')
    expect(describeSchedule({ kind: 'once', at }, 'zh-CN')).toContain('单次')
    expect(describeSchedule({ kind: 'once', at }, 'zh-CN')).toContain('2026/11/02 20:30')
  })

  it('flags a passed instant only when the caller supplies "now"', () => {
    expect(describeSchedule({ kind: 'once', at }, 'en', at + 1)).toContain('(passed)')
    expect(describeSchedule({ kind: 'once', at }, 'zh-CN', at + 1)).toContain('已过期')
    expect(describeSchedule({ kind: 'once', at }, 'en', at - 1)).not.toContain('passed')
  })
})
