/**
 * Tests for the takeover stats tracker (`lib/workflow/takeover-stats`):
 * records are appended and capped, aggregation computes the success rate and
 * per-reason failure counts, per-workflow filtering works, and clearing works.
 * Backed by an in-memory `chrome.storage.local` double (same pattern as the
 * takeover-pending spec).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearTakeoverStats,
  recordTakeoverStat,
  summarizeTakeoverStats,
} from '../src/lib/workflow/takeover-stats'

function makeChromeMock() {
  const store = new Map<string, unknown>()
  const local = {
    get: vi.fn(async (keys: string | string[] | null) => {
      if (keys === null) {
        const out: Record<string, unknown> = {}
        for (const [key, value] of store) out[key] = value
        return out
      }
      const wanted = typeof keys === 'string' ? [keys] : keys
      const out: Record<string, unknown> = {}
      for (const key of wanted) {
        if (store.has(key)) out[key] = store.get(key)
      }
      return out
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) store.set(key, value)
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const wanted = typeof keys === 'string' ? [keys] : keys
      for (const key of wanted) store.delete(key)
    }),
  }
  return { store, storage: { local } }
}

const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  at: Date.now() - 60_000,
  workflowId: 'wf-1',
  nodeId: 'node-b',
  completed: true,
  attempts: 1,
  ...overrides,
})

describe('takeover stats', () => {
  let mocks: ReturnType<typeof makeChromeMock>

  beforeEach(() => {
    mocks = makeChromeMock()
    vi.stubGlobal('chrome', mocks)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('aggregates the success rate and failure reasons', async () => {
    await recordTakeoverStat(record() as never)
    await recordTakeoverStat(record({ completed: false, reasonKind: 'captcha' }) as never)
    await recordTakeoverStat(record({ completed: false }) as never)
    const summary = await summarizeTakeoverStats()
    expect(summary.total).toBe(3)
    expect(summary.completed).toBe(1)
    expect(summary.successRate).toBeCloseTo(1 / 3)
    expect(summary.byReason[0]).toEqual({ reason: 'captcha', count: 1 })
    expect(summary.byReason).toContainEqual({ reason: 'unclassified', count: 1 })
    expect(summary.recent).toHaveLength(3)
  })

  it('filters by workflow when asked', async () => {
    await recordTakeoverStat(record({ workflowId: 'wf-1' }) as never)
    await recordTakeoverStat(record({ workflowId: 'wf-2', completed: false }) as never)
    const summary = await summarizeTakeoverStats('wf-2')
    expect(summary.total).toBe(1)
    expect(summary.completed).toBe(0)
  })

  it('caps the stored records to the most recent 200', async () => {
    // A fixed base so the last-record assertion does not race Date.now().
    const base = Date.now() - 400_000
    for (let i = 0; i < 230; i++) {
      await recordTakeoverStat(record({ at: base + i }) as never)
    }
    const summary = await summarizeTakeoverStats()
    expect(summary.total).toBe(200)
    // The OLDEST records were dropped, not the newest.
    expect(summary.recent[0]?.at).toBe(base + 229)
  })

  it('drops malformed stored entries instead of crashing', async () => {
    mocks.store.set('takeoverStats', [null, 'garbage', record(), { at: 'nope' }])
    const summary = await summarizeTakeoverStats()
    expect(summary.total).toBe(1)
  })

  it('clear clears', async () => {
    await recordTakeoverStat(record() as never)
    await clearTakeoverStats()
    expect((await summarizeTakeoverStats()).total).toBe(0)
  })
})
