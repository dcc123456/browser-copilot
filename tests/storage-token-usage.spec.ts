/**
 * Persistence tests for the token ledger (`lib/storage.ts`) — the half the pure
 * aggregation tests cannot cover: what actually lands in the store.
 *
 * Pinned here (design §4.3, acceptance R7/R8):
 *  - one append writes the detail record AND its contribution to the day
 *    rollup, derived from the same record, so the two views cannot disagree;
 *  - two concurrent appends both survive — a lost record is lost spend that no
 *    later read can repair;
 *  - the detail is capped while the rollup is not, so "since first use" stays
 *    complete after the chart-only detail has been truncated;
 *  - clearing usage does not touch conversations.
 *
 * `chrome.storage.local` is stubbed with an in-process map; with no directory
 * handle in a plain Node run, `fileStorageArea()` falls back to that mirror.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyRecordToDaily,
  buildTokenDashboard,
  dayKeyOf,
  MAX_TOKEN_RECORDS,
  recordOf,
  startOfDay,
  type TokenDailyStore,
  type TokenUsageRecord,
} from '../src/lib/token-ledger'
import { clearTokenUsage, readTokenUsage, recordTokenUsage } from '../src/lib/storage'

const data = new Map<string, unknown>()

beforeEach(() => {
  data.clear()
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        async get(keys: string | string[] | null) {
          if (!keys) return Object.fromEntries(data)
          const list = Array.isArray(keys) ? keys : [keys]
          const out: Record<string, unknown> = {}
          for (const key of list) if (data.has(key)) out[key] = data.get(key)
          return out
        },
        async set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) data.set(key, value)
        },
        async remove(keys: string | string[]) {
          for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key)
        },
      },
      session: {
        async get() {
          return {}
        },
        async set() {},
        async remove() {},
      },
    },
    runtime: { sendMessage: async () => ({}) },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** One finished request, shaped exactly like the accounting sink builds it. */
function usageRecord(
  id: string,
  at: number,
  inputTokens: number,
  outputTokens: number,
): TokenUsageRecord {
  return recordOf(
    { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    { id, at, consumer: 'chat', entityKey: `chat:${id}`, entityLabel: id, model: 'gpt-test' },
  )
}

describe('token ledger persistence', () => {
  it('appends the detail record and its day rollup together', async () => {
    const at = Date.now()
    await recordTokenUsage([usageRecord('r-1', at, 100, 40)])

    const { records, daily } = await readTokenUsage()
    expect(records.map((record) => record.id)).toEqual(['r-1'])
    expect(daily[dayKeyOf(at)]?.totals.totalTokens).toBe(140)
    expect(daily[dayKeyOf(at)]?.byEntity['chat:r-1']?.totalTokens).toBe(140)
  })

  it('keeps every record from two concurrent appends', async () => {
    const at = Date.now()
    await Promise.all([
      recordTokenUsage([usageRecord('a', at, 10, 1)]),
      recordTokenUsage([usageRecord('b', at + 1, 20, 2)]),
    ])

    const { records, daily } = await readTokenUsage()
    expect(records.map((record) => record.id)).toEqual(['b', 'a'])
    expect(daily[dayKeyOf(at)]?.totals.totalTokens).toBe(33)
  })

  it('caps the detail but never the rollup, so all-time totals stay complete', async () => {
    const fresh = Date.now()
    const day = 24 * 60 * 60 * 1000
    const oldest = fresh - MAX_TOKEN_RECORDS * day
    const seed: TokenUsageRecord[] = []
    const daily: TokenDailyStore = {}
    for (let i = 0; i < MAX_TOKEN_RECORDS; i += 1) {
      // One record per day: the rollup then has one day key per record, which is
      // what makes "the detail was truncated but the history was not" visible.
      const record = usageRecord(`old-${i}`, oldest + i * day, 1, 1)
      seed.push(record)
      applyRecordToDaily(daily, record)
    }
    // Seeded straight into the store: appending one at a time would need
    // MAX_TOKEN_RECORDS locked read-modify-writes to reach the same state.
    data.set('tokenUsage', seed)
    data.set('tokenUsageDaily', daily)

    await recordTokenUsage([usageRecord('new', fresh, 5, 5)])

    const stored = await readTokenUsage()
    expect(stored.records).toHaveLength(MAX_TOKEN_RECORDS)
    expect(stored.records[0]?.id).toBe('new')
    // The oldest record is gone from the detail but still in the day rollup.
    expect(stored.records.some((record) => record.id === 'old-0')).toBe(false)
    expect(Object.keys(stored.daily)).toContain(dayKeyOf(oldest))

    const dashboard = buildTokenDashboard(stored.records, stored.daily, 'all', fresh + day)
    expect(dashboard.firstRecordedAt).toBe(startOfDay(oldest))
    expect(dashboard.totals.requests).toBe(MAX_TOKEN_RECORDS + 1)
    expect(dashboard.totals.totalTokens).toBe(2 * MAX_TOKEN_RECORDS + 10)
  })

  it('clears usage without touching conversations', async () => {
    await recordTokenUsage([usageRecord('r-1', Date.now(), 10, 10)])
    data.set('conv:c-1', [{ role: 'user' }])
    data.set('conversations', [{ id: 'c-1' }])

    await clearTokenUsage()

    const { records, daily } = await readTokenUsage()
    expect(records).toEqual([])
    expect(daily).toEqual({})
    expect(data.get('conv:c-1')).toEqual([{ role: 'user' }])
    expect(data.get('conversations')).toEqual([{ id: 'c-1' }])
  })
})
