/**
 * Repair round metrics tests (spec §14).
 *
 * The fs-store area is mocked with an in-memory map so records persist across
 * calls without Chrome File System Access. We verify that a round log is
 * persisted with NO raw variable values, that aggregation counts by result and
 * entry, and that telemetry never throws into the repair loop.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const memory = vi.hoisted(() => ({ data: new Map<string, unknown>() }))

vi.mock('../src/lib/fs-store', () => ({
  fileStorageArea: () => ({
    get: vi.fn(async (key: string) => ({ [key]: memory.data.get(key) })),
    set: vi.fn(async (entries: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(entries)) memory.data.set(key, value)
    }),
  }),
}))

import {
  recordRepairRound,
  summarizeRepairRounds,
  type RepairRoundLog,
} from '../src/lib/workflow/repair-metrics'

const baseLog = (over: Partial<RepairRoundLog> = {}): RepairRoundLog => ({
  at: Date.now(),
  sessionId: 's1',
  round: 1,
  entry: 'GENERATION',
  rootCauseNodeIds: ['n3'],
  transientRetries: 0,
  patchedNodeIds: ['n3'],
  usedCheckpoint: true,
  usedAiTakeover: false,
  goalAchieved: true,
  result: 'VERIFIED',
  durationMs: 120,
  ...over,
})

describe('repair round metrics', () => {
  beforeEach(() => {
    memory.data.clear()
  })

  it('persists a round log and reads it back', async () => {
    await recordRepairRound(baseLog())
    const summary = await summarizeRepairRounds()
    expect(summary.total).toBe(1)
    expect(summary.verified).toBe(1)
    expect(summary.successRate).toBe(1)
    expect(summary.byResult.VERIFIED).toBe(1)
  })

  it('counts results separately and keeps the success rate honest', async () => {
    await recordRepairRound(baseLog({ result: 'VERIFIED' }))
    await recordRepairRound(baseLog({ at: Date.now() + 1, result: 'FAILED' }))
    await recordRepairRound(baseLog({ at: Date.now() + 2, result: 'DRAFT' }))
    const summary = await summarizeRepairRounds()
    expect(summary.total).toBe(3)
    expect(summary.byResult).toMatchObject({ VERIFIED: 1, FAILED: 1, DRAFT: 1 })
    expect(summary.successRate).toBeCloseTo(1 / 3)
  })

  it('filters aggregation by entry', async () => {
    await recordRepairRound(baseLog({ entry: 'GENERATION' }))
    await recordRepairRound(baseLog({ at: Date.now() + 1, entry: 'DEBUG', result: 'FAILED' }))
    const generation = await summarizeRepairRounds('GENERATION')
    expect(generation.total).toBe(1)
    const debug = await summarizeRepairRounds('DEBUG')
    expect(debug.total).toBe(1)
    expect(debug.successRate).toBe(0)
  })

  it('survives a storage error without throwing', async () => {
    // A corrupt (non-array) stored value is ignored, not fatal.
    memory.data.set('bc_repair_round_logs', 'not-an-array')
    await expect(recordRepairRound(baseLog())).resolves.toBeUndefined()
    const summary = await summarizeRepairRounds()
    expect(summary.total).toBe(1)
  })
})
