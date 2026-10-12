/**
 * Unit tests for the token ledger (Step 0 of
 * `specs/2026-10-12-token-usage-dashboard-plan.md`).
 *
 * These pin the three ways a dashboard can lie to a user:
 * 1. double counting — a cumulative turn snapshot stored as if it were one
 *    request's usage;
 * 2. wrong window — a "today" that uses UTC midnight instead of the user's
 *    local calendar day;
 * 3. silent truncation — a "since first use" total that quietly becomes the
 *    retained detail array's total once the cap is hit.
 *
 * Everything is timezone-agnostic: local-day arithmetic is exercised through
 * `dayKeyOf`/`startOfDay`, never against a hard-coded UTC offset.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_DAILY_ENTITIES,
  MAX_GROUP_ROWS,
  OTHER_ENTITY_KEY,
  addRecordToTally,
  applyRecordToDaily,
  bucketedDailySeries,
  buildTokenDashboard,
  coerceDailyStore,
  coerceTokenRecord,
  dailyGroupRows,
  dayKeyOf,
  emptyTally,
  entityKindOf,
  entityKeyFor,
  hourlySeries,
  rangeWindow,
  recordOf,
  startOfDay,
  sumTallies,
  type TokenConsumer,
  type TokenDailyStore,
  type TokenUsageRecord,
} from '../src/lib/token-ledger'

const DAY_MS = 86_400_000

function record(overrides: Partial<TokenUsageRecord> = {}): TokenUsageRecord {
  const at = overrides.at ?? startOfDay(Date.now()) + 3_600_000
  return {
    id: overrides.id ?? `rec-${Math.random().toString(36).slice(2)}`,
    at,
    consumer: overrides.consumer ?? 'chat',
    entityKey: overrides.entityKey ?? 'chat:default',
    entityLabel: overrides.entityLabel ?? 'New conversation',
    model: overrides.model ?? 'deepseek-chat',
    inputTokens: overrides.inputTokens ?? 100,
    outputTokens: overrides.outputTokens ?? 50,
    cachedInputTokens: overrides.cachedInputTokens ?? 0,
    reasoningTokens: overrides.reasoningTokens ?? 0,
    totalTokens: overrides.totalTokens ?? 150,
  }
}

function dailyFrom(records: TokenUsageRecord[]): TokenDailyStore {
  const daily: TokenDailyStore = {}
  for (const entry of records) applyRecordToDaily(daily, entry)
  return daily
}

describe('recordOf — the unit of the ledger is one request', () => {
  it('keeps each round separate instead of storing a cumulative snapshot', () => {
    // A 3-round turn: agent.ts folds each round's usage into a running total
    // and republishes it. Storing the snapshot would count round 1 three times.
    const rounds = [
      { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      { inputTokens: 200, outputTokens: 20, totalTokens: 220 },
      { inputTokens: 300, outputTokens: 30, totalTokens: 330 },
    ]
    const records = rounds.map((round, index) =>
      recordOf(round, {
        id: `r${index}`,
        at: 1_700_000_000_000 + index,
        consumer: 'chat',
        entityKey: 'chat:default',
        entityLabel: 'Thread',
        model: 'm',
      }),
    )
    expect(records).toHaveLength(3)
    const tally = records.reduce((acc, entry) => addRecordToTally(acc, entry), emptyTally())
    expect(tally.totalTokens).toBe(660)
    expect(tally.requests).toBe(3)
    // The cumulative snapshot the panel shows equals the sum of the records —
    // the equivalence the dashboard's accuracy rests on.
    expect(sumTallies([tally]).totalTokens).toBe(110 + 220 + 330)
  })

  it('falls back to input + output when the provider omits the total', () => {
    const made = recordOf(
      { inputTokens: 10, outputTokens: 5, totalTokens: 0 },
      {
        id: 'x',
        at: 1,
        consumer: 'vision',
        entityKey: 'chat:default',
        entityLabel: 'Thread',
        model: 'm',
      },
    )
    expect(made.totalTokens).toBe(15)
    expect(made.cachedInputTokens).toBe(0)
    expect(made.reasoningTokens).toBe(0)
  })

  it('carries cache and reasoning detail through', () => {
    const made = recordOf(
      {
        inputTokens: 1000,
        outputTokens: 500,
        cachedInputTokens: 700,
        reasoningTokens: 200,
        totalTokens: 1500,
      },
      {
        id: 'x',
        at: 1,
        consumer: 'workflow-generation',
        entityKey: 'chat:gen',
        entityLabel: 'Generate',
        model: 'deepseek-reasoner',
        providerId: 'p1',
      },
    )
    expect(made.cachedInputTokens).toBe(700)
    expect(made.reasoningTokens).toBe(200)
    expect(made.providerId).toBe('p1')
  })
})

describe('local calendar windows', () => {
  it('bounds "today" at the local midnight, not UTC', () => {
    const now = Date.now()
    const window = rangeWindow('today', now)
    expect(window.from).toBe(startOfDay(now))
    expect(window.to - window.from).toBe(DAY_MS)
    expect(new Date(window.from).getHours()).toBe(0)
    expect(window.unit).toBe('hour')
  })

  it('spans 7 and 30 local days for the medium ranges', () => {
    const now = Date.now()
    expect(rangeWindow('7d', now).from).toBe(startOfDay(now) - 6 * DAY_MS)
    expect(rangeWindow('30d', now).from).toBe(startOfDay(now) - 29 * DAY_MS)
    expect(rangeWindow('7d', now).unit).toBe('day')
  })

  it('coarsens the all-time buckets instead of emitting thousands of points', () => {
    const now = startOfDay(Date.now()) + 10 * 3_600_000
    expect(rangeWindow('all', now, now - 30 * DAY_MS).unit).toBe('day')
    expect(rangeWindow('all', now, now - 200 * DAY_MS).unit).toBe('week')
    expect(rangeWindow('all', now, now - 500 * DAY_MS).unit).toBe('month')
  })

  it('names days by the local calendar', () => {
    const localNoon = new Date(2026, 9, 12, 12, 0, 0).getTime()
    expect(dayKeyOf(localNoon)).toBe('2026-10-12')
    expect(dayKeyOf(new Date(2026, 0, 5, 0, 30).getTime())).toBe('2026-01-05')
  })
})

describe('daily rollup', () => {
  it('agrees with the sum of the records it summarises', () => {
    const records = [
      record({ consumer: 'chat', entityKey: 'chat:a', entityLabel: 'Alpha' }),
      record({
        consumer: 'chat',
        entityKey: 'chat:a',
        entityLabel: 'Alpha',
        totalTokens: 999,
        inputTokens: 900,
        outputTokens: 99,
      }),
      record({
        consumer: 'scheduled-task',
        entityKey: 'task:1',
        entityLabel: 'Nightly',
        at: startOfDay(Date.now()) + 5_000,
      }),
    ]
    const daily = dailyFrom(records)
    const window = rangeWindow('all', Date.now(), records[0]!.at)
    const groups = dailyGroupRows(daily, window)
    const totalFromRollup = sumTallies(Object.values(daily).map((day) => day.totals))
    const totalFromRecords = records.reduce(
      (acc, entry) => addRecordToTally(acc, entry),
      emptyTally(),
    )
    expect(totalFromRollup.totalTokens).toBe(totalFromRecords.totalTokens)
    expect(totalFromRollup.requests).toBe(3)
    expect(groups.byConsumer.map((row) => row.key)).toContain('scheduled-task')
  })

  it('keeps per-entity rows so a single chat or task can be read off', () => {
    const daily = dailyFrom([
      record({
        entityKey: 'chat:a',
        entityLabel: 'Alpha',
        totalTokens: 400,
        inputTokens: 300,
        outputTokens: 100,
      }),
      record({
        entityKey: 'chat:b',
        entityLabel: 'Beta',
        totalTokens: 100,
        inputTokens: 80,
        outputTokens: 20,
      }),
      record({
        entityKey: 'task:nightly',
        entityLabel: 'Nightly',
        consumer: 'scheduled-task',
        totalTokens: 700,
        inputTokens: 600,
        outputTokens: 100,
      }),
    ])
    const rows = dailyGroupRows(
      daily,
      rangeWindow('all', Date.now(), startOfDay(Date.now())),
    ).byEntity
    expect(rows.map((row) => row.label)).toEqual(['Nightly', 'Alpha', 'Beta'])
    expect(rows[0]!.totals.totalTokens).toBe(700)
  })

  it('folds the smallest entity once the per-day bound is hit, keeping the tokens', () => {
    const records: TokenUsageRecord[] = []
    for (let i = 0; i < MAX_DAILY_ENTITIES + 5; i += 1) {
      records.push(
        record({
          entityKey: `chat:${i}`,
          entityLabel: `Thread ${i}`,
          // Ascending spend, so the earliest threads are the ones folded away.
          inputTokens: (i + 1) * 10,
          outputTokens: 0,
          totalTokens: (i + 1) * 10,
        }),
      )
    }
    const daily = dailyFrom(records)
    const day = Object.values(daily)[0]!
    expect(Object.keys(day.byEntity).length).toBeLessThanOrEqual(MAX_DAILY_ENTITIES)
    expect(day.byEntity[OTHER_ENTITY_KEY]).toBeDefined()
    const folded = sumTallies(Object.values(day.byEntity))
    expect(folded.totalTokens).toBe(records.reduce((sum, entry) => sum + entry.totalTokens, 0))
    expect(folded.requests).toBe(records.length)
  })

  it('survives a truncated detail array: the rollup still reports the full history', () => {
    const old = record({
      at: startOfDay(Date.now()) - 100 * DAY_MS + 3_600_000,
      totalTokens: 5000,
      inputTokens: 4000,
      outputTokens: 1000,
    })
    const fresh = record({ at: startOfDay(Date.now()) + 3_600_000, totalTokens: 100 })
    const daily = dailyFrom([old, fresh])
    // The cap dropped the old detail record; the aggregate must still count it.
    const retained: TokenUsageRecord[] = [fresh]
    const stats = buildTokenDashboard(
      retained,
      daily,
      'all',
      startOfDay(Date.now()) + 12 * 3_600_000,
    )
    expect(stats.totals.totalTokens).toBe(5100)
    // The 'since' stamp comes from the rollup, so it predates the retained detail.
    expect(stats.firstRecordedAt).toBe(startOfDay(old.at))
    expect(dayKeyOf(old.at)).toBe(stats.dayKeys[0])
  })
})

describe('series bucketing', () => {
  it('emits all 24 hourly buckets so a late-night spike still draws a curve', () => {
    const now = startOfDay(Date.now()) + 3_600_000
    const window = rangeWindow('today', now + 3_600_000)
    const series = hourlySeries([record({ at: startOfDay(now) + 23 * 3_600_000 })], window)
    expect(series).toHaveLength(24)
    expect(series[0]!.totals.requests).toBe(0)
    expect(series[23]!.totals.requests).toBe(1)
    expect(series.map((point) => point.at)).toEqual(
      [...series.map((point) => point.at)].sort((a, b) => a - b),
    )
  })

  it('zero-fills unused days instead of dropping the bucket', () => {
    const now = startOfDay(Date.now()) + 3_600_000
    const window = rangeWindow('7d', now)
    const series = bucketedDailySeries(dailyFrom([record({ at: now })]), window)
    expect(series).toHaveLength(7)
    expect(series.filter((point) => point.totals.requests === 0)).toHaveLength(6)
    expect(series[6]!.totals.totalTokens).toBe(150)
  })

  it('buckets a long all-time span into weeks', () => {
    const now = startOfDay(Date.now()) + 3_600_000
    const daily = dailyFrom([
      record({ at: now - 100 * DAY_MS, totalTokens: 100 }),
      record({ at: now - 99 * DAY_MS, totalTokens: 200 }),
      record({ at: now, totalTokens: 300 }),
    ])
    const stats = buildTokenDashboard([], daily, 'all', now)
    // A 100-day history is 100 daily points — too many to read, so the curve
    // aggregates by week while still accounting for every token.
    expect(stats.window.unit).toBe('week')
    expect(stats.series.length).toBeLessThanOrEqual(16)
    expect(sumTallies(stats.series.map((point) => point.totals)).totalTokens).toBe(600)
  })
})

describe('storage coercion', () => {
  it.each([
    ['not an object', 42],
    ['missing id', { at: 1, consumer: 'chat', entityKey: 'chat:a' }],
    ['non-numeric time', { id: 'a', at: 'now', consumer: 'chat', entityKey: 'chat:a' }],
    ['unknown consumer', { id: 'a', at: 1, consumer: 'magic', entityKey: 'chat:a' }],
    ['missing entity', { id: 'a', at: 1, consumer: 'chat' }],
  ])('drops %s', (_label, value) => {
    expect(coerceTokenRecord(value)).toBeNull()
  })

  it('normalises a usable record and derives the missing total', () => {
    const coerced = coerceTokenRecord({
      id: 'a',
      at: 10,
      consumer: 'ai-debug',
      entityKey: 'workflow:wf1',
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 0,
    })
    expect(coerced?.totalTokens).toBe(14)
    expect(coerced?.entityLabel).toBe('workflow:wf1')
    expect(coerced?.model).toBe('unknown')
    expect(coerced?.cachedInputTokens).toBe(0)
  })

  it('rebuilds day totals from the consumer groups rather than trusting disk', () => {
    const store = coerceDailyStore({
      '2026-10-12': {
        totals: { totalTokens: 999_999, requests: 77 },
        byConsumer: { chat: { inputTokens: 100, outputTokens: 50, totalTokens: 150, requests: 2 } },
        byEntity: { 'chat:a': { label: 'Alpha', totalTokens: 150, requests: 2 } },
      },
      'bogus-key': { totals: {} },
      '2026-10-13': 'junk',
    })
    expect(Object.keys(store)).toEqual(['2026-10-12'])
    expect(store['2026-10-12']!.totals.totalTokens).toBe(150)
    expect(store['2026-10-12']!.totals.requests).toBe(2)
    expect(store['2026-10-12']!.byEntity['chat:a']!.label).toBe('Alpha')
  })

  it('sums a list of tallies for the folded tail rows', () => {
    const merged = sumTallies([
      { ...emptyTally(), totalTokens: 10, requests: 1 },
      { ...emptyTally(), totalTokens: 20, requests: 2 },
    ])
    expect(merged.totalTokens).toBe(30)
    expect(merged.requests).toBe(3)
  })
})

describe('dashboard assembly', () => {
  it('folds the entity tail into one row and flags the truncation', () => {
    const now = startOfDay(Date.now()) + 3_600_000
    const records = Array.from({ length: MAX_GROUP_ROWS + 3 }, (_unused, index) =>
      record({
        at: now,
        entityKey: `chat:${index}`,
        entityLabel: `Thread ${index}`,
        inputTokens: index + 1,
        outputTokens: 0,
        totalTokens: index + 1,
      }),
    )
    // Each day caps its entity map, so spread the threads over enough days to
    // reach the row limit without hitting the per-day bound first.
    const spread = records.map((entry, index) => ({ ...entry, at: now - index * DAY_MS }))
    const stats = buildTokenDashboard(spread, dailyFrom(spread), 'all', now)
    expect(stats.entityTruncated).toBe(true)
    expect(stats.byEntity.at(-1)!.key).toBe(OTHER_ENTITY_KEY)
    expect(stats.byEntity.length).toBe(MAX_GROUP_ROWS + 1)
  })

  it('reports an empty ledger honestly instead of inventing zeros for a range', () => {
    const stats = buildTokenDashboard([], {}, '7d', Date.now())
    expect(stats.totals.totalTokens).toBe(0)
    expect(stats.totals.requests).toBe(0)
    expect(stats.firstRecordedAt).toBeNull()
    expect(stats.byConsumer).toHaveLength(0)
    expect(stats.series.every((point) => point.totals.requests === 0)).toBe(true)
  })

  it('narrows totals to the selected range', () => {
    const now = startOfDay(Date.now()) + 3_600_000
    const records = [
      record({ at: now - 10 * DAY_MS, totalTokens: 1000 }),
      record({ at: now, totalTokens: 100 }),
    ]
    const daily = dailyFrom(records)
    expect(buildTokenDashboard(records, daily, '7d', now).totals.totalTokens).toBe(100)
    expect(buildTokenDashboard(records, daily, '30d', now).totals.totalTokens).toBe(1100)
    expect(buildTokenDashboard(records, daily, 'all', now).totals.totalTokens).toBe(1100)
    expect(buildTokenDashboard(records, daily, 'today', now).totals.totalTokens).toBe(100)
  })

  it('keeps every known consumer visible so an unrecorded one is noticeable', () => {
    const now = startOfDay(Date.now()) + 3_600_000
    const daily = dailyFrom([record({ at: now, consumer: 'chat' as TokenConsumer })])
    const stats = buildTokenDashboard([], daily, 'today', now)
    expect(stats.byConsumer.map((row) => row.key)).toEqual(['chat'])
  })
})

describe('entityKindOf — what a dashboard row can be named after and linked to', () => {
  it('splits every ledger kind back into kind and id', () => {
    for (const kind of ['chat', 'task', 'workflow', 'run', 'session', 'external'] as const) {
      expect(entityKindOf(entityKeyFor(kind, 'abc123'))).toEqual({ kind, id: 'abc123' })
    }
  })

  it('keeps a nested id intact — only the first colon is the separator', () => {
    expect(entityKindOf('chat:external-gen:r7Kx')).toEqual({
      kind: 'chat',
      id: 'external-gen:r7Kx',
    })
  })

  it('returns nothing for a key it does not own, so callers show it verbatim', () => {
    expect(entityKindOf(OTHER_ENTITY_KEY)).toBeUndefined()
    expect(entityKindOf('')).toBeUndefined()
    expect(entityKindOf('nonsense:abc')).toBeUndefined()
    expect(entityKindOf(':abc')).toBeUndefined()
  })
})
