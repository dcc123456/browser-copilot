/**
 * Generation attempt store tests.
 *
 * The fs-store area is mocked with an in-memory map. These pin the three
 * properties emission depends on: one record per attempt (upsert, not append),
 * a bounded window, and a best-effort write that never throws or changes the
 * record the caller receives.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const memory = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  failGet: false,
  failSet: false,
}))

vi.mock('../src/lib/fs-store', () => ({
  fileStorageArea: () => ({
    get: vi.fn(async (key: string) => {
      if (memory.failGet) throw new Error('read failed')
      return { [key]: memory.data.get(key) }
    }),
    set: vi.fn(async (entries: Record<string, unknown>) => {
      if (memory.failSet) throw new Error('write failed')
      for (const [key, value] of Object.entries(entries)) memory.data.set(key, value)
    }),
  }),
}))

import {
  clearGenerationAttempts,
  recordGenerationAttempt,
} from '../src/lib/workflow/generation-attempt-store'

import type { ComposeFacts, ReplayFacts } from '../src/lib/workflow/generation-attempt'

const KEY = 'bc_generation_attempts'

function composeFacts(overrides: Partial<ComposeFacts> = {}): ComposeFacts {
  return {
    saved: true,
    nodeCount: 4,
    staticOk: true,
    staticCodes: [],
    staticErrorCount: 0,
    staticWarningCount: 0,
    trial: { outcome: 'passed', full: true, coveredSteps: 4, totalSteps: 4 },
    ...overrides,
  }
}

function replayFacts(overrides: Partial<ReplayFacts> = {}): ReplayFacts {
  return {
    ran: true,
    ok: true,
    verified: true,
    proven: true,
    outcome: 'ok',
    coveredSteps: 4,
    totalSteps: 4,
    ...overrides,
  }
}

const stored = (): Record<string, unknown>[] =>
  (memory.data.get(KEY) as Record<string, unknown>[]) ?? []

describe('generation attempt store', () => {
  beforeEach(() => {
    memory.data.clear()
    memory.failGet = false
    memory.failSet = false
  })

  it('upserts compose then replay into one record and returns the merge', async () => {
    const at = Date.now()
    const composed = await recordGenerationAttempt({
      attemptId: 'workflow-1',
      at,
      origin: 'chat-generate',
      compose: composeFacts(),
    })
    expect(composed.pass).toBe(false)
    expect(composed.score).toBe(0.4)

    const replayed = await recordGenerationAttempt({
      attemptId: 'workflow-1',
      at: at + 1,
      replay: replayFacts({ goal: { level: 'L3', certified: true, unmetCount: 0 } }),
    })
    expect(replayed.pass).toBe(true)
    expect(replayed.score).toBe(1)
    expect(replayed.origin).toBe('chat-generate')
    expect(replayed.compose).toEqual(composeFacts())
    expect(stored()).toHaveLength(1)
    expect(stored()[0]?.['attemptId']).toBe('workflow-1')
  })

  it('keeps attempts with different ids apart', async () => {
    const at = Date.now()
    await recordGenerationAttempt({ attemptId: 'workflow-1', at, compose: composeFacts() })
    await recordGenerationAttempt({ attemptId: 'workflow-2', at, compose: composeFacts() })
    expect(stored()).toHaveLength(2)
  })

  it('drops records outside the 30-day window and the 500-record cap', async () => {
    const now = Date.now()
    const seeded = Array.from({ length: 500 }, (_, index) => ({
      attemptId: `old-${index}`,
      at: now - 31 * 24 * 60 * 60 * 1000,
      pass: false,
      score: 0,
    }))
    memory.data.set(KEY, seeded)
    await recordGenerationAttempt({ attemptId: 'new', at: now, compose: composeFacts() })
    expect(stored()).toHaveLength(1)
    expect(stored()[0]?.['attemptId']).toBe('new')

    memory.data.set(
      KEY,
      Array.from({ length: 500 }, (_, index) => ({
        attemptId: `fresh-${index}`,
        at: now,
        pass: false,
        score: 0,
      })),
    )
    await recordGenerationAttempt({ attemptId: 'newest', at: now, compose: composeFacts() })
    expect(stored()).toHaveLength(500)
    expect(stored()[0]?.['attemptId']).toBe('fresh-1')
    expect(stored()[499]?.['attemptId']).toBe('newest')
  })

  it('ignores malformed stored entries instead of throwing', async () => {
    memory.data.set(KEY, [
      { not: 'an attempt' },
      null,
      { attemptId: 'a', at: 1, pass: true, score: 1 },
    ])
    const record = await recordGenerationAttempt({
      attemptId: 'a',
      at: Date.now(),
      compose: composeFacts(),
    })
    expect(record.attemptId).toBe('a')
    expect(stored()).toHaveLength(1)
  })

  it('returns the merged record when the write fails', async () => {
    memory.failSet = true
    const record = await recordGenerationAttempt({
      attemptId: 'workflow-1',
      at: Date.now(),
      compose: composeFacts(),
    })
    expect(record.pass).toBe(false)
    expect(record.score).toBe(0.4)
    expect(record.compose?.nodeCount).toBe(4)
    expect(stored()).toHaveLength(0)
  })

  it('returns the merged record when the read fails', async () => {
    memory.failGet = true
    const record = await recordGenerationAttempt({
      attemptId: 'workflow-1',
      at: Date.now(),
      compose: composeFacts(),
    })
    expect(record.compose?.saved).toBe(true)
    expect(stored()).toHaveLength(1)
  })

  it('clears every record', async () => {
    await recordGenerationAttempt({
      attemptId: 'workflow-1',
      at: Date.now(),
      compose: composeFacts(),
    })
    await clearGenerationAttempts()
    expect(stored()).toEqual([])
  })
})
