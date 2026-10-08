/**
 * Replay-success metric tests (plan Step 6 · D4).
 *
 * The metric is the only number that says whether this whole line of work
 * helped, so its two interesting properties are worth pinning: a revision is
 * graded exactly once (a retry after a failure must not improve the score), and
 * a garbage record in storage is dropped rather than crashing the aggregation.
 * As everywhere else, metrics are observation: they never throw into a run.
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
  latestFirstRunOf,
  latestFirstRuns,
  normalizeFirstRunRecord,
  observeFirstRunOfRevision,
  recordReplayFirstRun,
  summarizeFirstRunRecords,
  summarizeReplayFirstRuns,
  type ReplayFirstRunRecord,
} from '../src/lib/workflow/replay-metrics'
import type { Workflow, WorkflowSettings } from '../src/lib/workflow/types'

const baseSettings = (provenance?: WorkflowSettings['provenance']): WorkflowSettings => ({
  saveLog: false,
  debugMode: false,
  notification: false,
  reuseLastState: false,
  ...(provenance ? { provenance } : {}),
})

const KEY = 'bc_replay_first_run_logs'

const record = (over: Partial<ReplayFirstRunRecord> = {}): ReplayFirstRunRecord => ({
  workflowId: 'wf1',
  revision: 1,
  at: 1_700_000_000_000,
  outcome: 'ok',
  degradedSteps: 0,
  degradeRungs: [],
  autoRepaired: false,
  ...over,
})

describe('replay first-run metric', () => {
  beforeEach(() => {
    memory.data.clear()
  })

  it('records the first run of a revision and reads it back', async () => {
    await expect(
      recordReplayFirstRun({ workflowId: 'wf1', revision: 1, outcome: 'failed', failureCode: 'LOCATOR_NOT_FOUND' }),
    ).resolves.toBeDefined()
    const summary = await summarizeReplayFirstRuns()
    expect(summary.total).toBe(1)
    expect(summary.byFailureCode.LOCATOR_NOT_FOUND).toBe(1)
    expect(summary.firstRunRate).toBe(0)
  })

  it('grades a revision once: a later success does not improve the score', async () => {
    await recordReplayFirstRun({ workflowId: 'wf1', revision: 1, outcome: 'failed' })
    await recordReplayFirstRun({ workflowId: 'wf1', revision: 1, outcome: 'ok' })
    const stored = memory.data.get(KEY)
    expect(Array.isArray(stored) ? stored.length : stored).toBe(1)
    expect((await latestFirstRunOf('wf1'))?.outcome).toBe('failed')
  })

  it('keeps separate records per revision', async () => {
    await recordReplayFirstRun({ workflowId: 'wf1', revision: 1, outcome: 'failed' })
    await recordReplayFirstRun({ workflowId: 'wf1', revision: 2, outcome: 'ok' })
    const summary = await summarizeReplayFirstRuns()
    expect(summary.total).toBe(2)
    expect(summary.firstRunRate).toBeCloseTo(0.5)
    expect((await latestFirstRunOf('wf1'))?.revision).toBe(2)
  })

  it('never throws into the run when storage holds garbage', async () => {
    memory.data.set(KEY, 'not-an-array')
    await expect(
      recordReplayFirstRun({ workflowId: 'wf1', revision: 1, outcome: 'ok' }),
    ).resolves.toBeDefined()
    memory.data.set(KEY, [null, 42, { workflowId: 'x' }, { outcome: 'ok' }])
    expect(await summarizeReplayFirstRuns()).toMatchObject({ total: 0 })
  })

  it('drops records without an identity', () => {
    expect(normalizeFirstRunRecord({ workflowId: '', revision: 1, at: 1, outcome: 'ok' })).toBeUndefined()
    expect(normalizeFirstRunRecord({ workflowId: 'w', at: 1, outcome: 'ok' })).toBeUndefined()
    expect(normalizeFirstRunRecord({ workflowId: 'w', revision: 1, outcome: 'ok' })).toBeUndefined()
    expect(
      normalizeFirstRunRecord({ workflowId: 'w', revision: 1, at: 1, outcome: 'succeeded' }),
    ).toBeUndefined()
  })

  it('fills in the observation defaults instead of trusting the caller', () => {
    const normalized = normalizeFirstRunRecord({
      workflowId: 'w',
      revision: 3,
      at: 5,
      outcome: 'failed',
      degradeRungs: [1, 'nope', 4, 0],
      degradedSteps: 'many',
      autoRepaired: 'yes',
      trialOutcome: 'bogus',
    })
    expect(normalized).toEqual({
      workflowId: 'w',
      revision: 3,
      at: 5,
      outcome: 'failed',
      degradeRungs: [1, 4],
      degradedSteps: 0,
      autoRepaired: false,
    })
  })

  it('separates a clean pass from one that needed repair or the ladder', () => {
    const summary = summarizeFirstRunRecords([
      record(),
      record({ workflowId: 'wf2', autoRepaired: true }),
      record({ workflowId: 'wf3', degradeRungs: [2], degradedSteps: 1 }),
      record({ workflowId: 'wf4', degradeRungs: [4], degradedSteps: 1 }),
      record({ workflowId: 'wf5', outcome: 'failed' }),
    ])
    expect(summary).toMatchObject({
      total: 5,
      ok: 4,
      failed: 1,
      cleanPasses: 1,
      rung4Records: 1,
      degradedStepTotal: 2,
    })
    expect(summary.firstRunRate).toBeCloseTo(0.8)
    expect(summary.cleanPassRate).toBeCloseTo(0.2)
  })

  it('reports zero rates, not NaN, before anything is measured', () => {
    expect(summarizeFirstRunRecords([])).toMatchObject({
      total: 0,
      firstRunRate: 0,
      cleanPassRate: 0,
    })
  })

  it('prunes records older than the retention window', async () => {
    const ancient = record({ workflowId: 'old', revision: 1, at: 1 })
    memory.data.set(KEY, [ancient])
    await recordReplayFirstRun({ workflowId: 'wf1', revision: 1, outcome: 'ok' })
    const stored = memory.data.get(KEY) as ReplayFirstRunRecord[]
    expect(stored.map((entry) => entry.workflowId)).toEqual(['wf1'])
  })

  it('returns one record per workflow for a whole list', async () => {
    await recordReplayFirstRun({ workflowId: 'wf1', revision: 1, outcome: 'failed' })
    await recordReplayFirstRun({
      workflowId: 'wf1',
      revision: 2,
      outcome: 'ok',
      at: Date.now() + 1_000,
    })
    await recordReplayFirstRun({ workflowId: 'wf2', revision: 1, outcome: 'cancelled' })
    const latest = await latestFirstRuns()
    expect(latest).toHaveLength(2)
    expect(latest.find((entry) => entry.workflowId === 'wf1')).toMatchObject({
      revision: 2,
      outcome: 'ok',
    })
  })
})

/** Let the fire-and-forget write inside `observeFirstRunOfRevision` settle. */
async function flushed(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('observeFirstRunOfRevision', () => {
  beforeEach(() => {
    memory.data.clear()
  })

  const generated = (over: Partial<Workflow> = {}): Workflow => ({
    id: 'wf1',
    name: 'demo',
    createdAt: 1,
    updatedAt: 1,
    drawflow: { nodes: [], edges: [] },
    settings: baseSettings('chat-generate'),
    ...over,
  })

  it('grades only generated graphs, so hand-built runs cannot dilute the number', async () => {
    observeFirstRunOfRevision(generated({ settings: baseSettings() }), { outcome: 'ok' })
    await flushed()
    expect(await summarizeReplayFirstRuns()).toMatchObject({ total: 0 })
  })

  it('carries the ladder rungs and the failed step out of a real run result', async () => {
    observeFirstRunOfRevision(generated({ revision: 4 }), {
      outcome: 'failed',
      error: 'LOCATOR_NOT_FOUND: no candidate matched',
      trace: { failedNodeId: 'n7' },
      degradations: [{ rung: 2 }, { rung: 4 }],
    })
    await flushed()
    expect(await latestFirstRunOf('wf1')).toMatchObject({
      revision: 4,
      outcome: 'failed',
      failedNodeId: 'n7',
      failureCode: 'LOCATOR_NOT_FOUND',
      degradedSteps: 2,
      degradeRungs: [2, 4],
      autoRepaired: false,
    })
  })

  it('keeps what the pre-save trial said alongside the run', async () => {
    observeFirstRunOfRevision(
      generated({
        settings: {
          ...baseSettings('chat-generate'),
          trialRun: {
            outcome: 'skipped',
            reason: 'no page was open',
            at: 1,
            full: false,
            coveredSteps: 0,
            totalSteps: 3,
          },
        },
      }),
      { outcome: 'ok' },
    )
    await flushed()
    expect(await latestFirstRunOf('wf1')).toMatchObject({
      outcome: 'ok',
      trialOutcome: 'skipped',
      trialSkippedReason: 'no page was open',
    })
  })
})
