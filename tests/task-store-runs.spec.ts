/**
 * Tests for the run log's persistence round trip (`lib/task-store`):
 *
 *  - a finished run keeps its `workflowId` through a write and a read — the
 *    field is the only durable link from a run back to its workflow, so losing
 *    it on either side silently breaks "which run belongs to this workflow";
 *  - a record persisted before the field existed still parses, with only its
 *    label to go on;
 *  - a malformed id is dropped rather than trusted;
 *  - what lands is exactly what a reader gets back: a debug step's variable bag
 *    (megabytes of image data URLs) never reaches storage, and the whole key
 *    stays inside the budget the storage fallback can carry.
 *
 * `chrome.storage.local` is stubbed with an in-process map. In a plain Node run
 * `fileStorageArea()` resolves no directory handle, so it falls back to that
 * mirror — which is exactly the path under test. No chrome, no filesystem.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listRuns, recordFinishedRun } from '../src/lib/task-store'
import { MAX_OUTPUT_STRING, MAX_RUN_OUTPUTS_BYTES } from '../src/lib/task-chain'
import type { TaskRunStep } from '../src/lib/scheduler-types'

/** The storage key `lib/task-store` keeps its run log under. */
const KEY_RUNS = 'scheduledTaskRuns'
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
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('run log workflow attribution', () => {
  it('keeps the workflow id through a write and a read', async () => {
    await recordFinishedRun({
      runId: 'run-1',
      workflowId: 'wf-a',
      label: 'Login flow',
      source: 'manual',
      outcome: 'failed',
      summary: 'step 3 failed',
    })

    const [run] = await listRuns()
    expect(run).toMatchObject({
      id: 'run-1',
      workflowId: 'wf-a',
      label: 'Login flow',
      ok: false,
      summary: 'step 3 failed',
    })
  })

  it('parses a record persisted before the id was stored', async () => {
    data.set(KEY_RUNS, [
      {
        id: 'legacy',
        label: 'Login flow',
        trigger: 'manual',
        at: 1,
        ok: true,
        skipped: false,
        summary: '',
      },
    ])

    const [run] = await listRuns()
    // The label survives — it is all an older record has.
    expect(run).toMatchObject({ id: 'legacy', label: 'Login flow' })
    expect(run?.workflowId).toBeUndefined()
  })

  it('drops a malformed workflow id instead of trusting it', async () => {
    data.set(KEY_RUNS, [
      {
        id: 'bad',
        label: 'Login flow',
        trigger: 'manual',
        at: 1,
        ok: true,
        skipped: false,
        summary: '',
        workflowId: 42,
      },
    ])

    const [run] = await listRuns()
    expect(run?.workflowId).toBeUndefined()
  })
})

describe('run log size bound', () => {
  /** A step as the in-memory board has it: a debug run attaches the block's whole variable bag. */
  function stepWithVars(image: string): TaskRunStep {
    return {
      at: 2,
      kind: 'tool',
      text: 'draw 3 images',
      nodeId: 'n-3',
      label: 'Generate images',
      vars: { generatedImages: [image] },
    } as unknown as TaskRunStep
  }

  it('keeps a step line and its block, but never its variable bag', async () => {
    const image = `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`
    await recordFinishedRun({
      runId: 'run-img',
      workflowId: 'wf-a',
      source: 'manual',
      outcome: 'ok',
      steps: [stepWithVars(image)],
    })

    const stored = data.get(KEY_RUNS) as Record<string, unknown>[]
    expect(JSON.stringify(stored)).not.toContain('data:image/png')
    // What landed is exactly what a reader gets back — no field that a later
    // write would silently flatten.
    expect((stored[0]!.steps as unknown[])[0]).toEqual({
      at: 2,
      kind: 'tool',
      text: 'draw 3 images',
      nodeId: 'n-3',
      label: 'Generate images',
    })
    const [run] = await listRuns()
    expect(run?.steps?.[0]).toMatchObject({ nodeId: 'n-3', text: 'draw 3 images' })
  })

  it('carries how a run recovered through the round trip', async () => {
    await recordFinishedRun({
      runId: 'run-repaired',
      workflowId: 'wf-a',
      source: 'manual',
      outcome: 'ok',
      failureCategory: 'LOCATOR',
      repaired: true,
      takeover: true,
    })

    const [run] = await listRuns()
    // The health summary counts repaired/resumed runs off the persisted log, so
    // losing the flags here means a repaired workflow looks never-healed.
    expect(run).toMatchObject({ repaired: true, takeover: true, failureCategory: 'LOCATOR' })
    expect(run?.resumed).toBeUndefined()
  })

  it('shrinks an oversize step line instead of trusting what is already stored', async () => {
    // A log written by an older build can already hold the payload, and this is
    // the one path every reader passes through.
    data.set(KEY_RUNS, [
      {
        id: 'legacy-big',
        trigger: 'manual',
        source: 'manual',
        at: 5,
        ok: true,
        skipped: false,
        summary: '',
        steps: [{ at: 1, kind: 'result', text: 'y'.repeat(3 * 1024 * 1024) }],
      },
    ])

    await recordFinishedRun({ runId: 'run-after', source: 'manual', outcome: 'ok' })
    const stored = data.get(KEY_RUNS) as { id: string; steps?: { text: string }[] }[]
    const legacy = stored.find((r) => r.id === 'legacy-big')!
    expect(legacy.steps?.[0]?.text).toContain('not persisted')
    expect(legacy.steps?.[0]?.text.length).toBeLessThan(1024)
  })

  it('sheds whole oldest runs to stay inside the byte budget', async () => {
    const big = 'x'.repeat(8000) // under the per-string cap, so it costs real bytes
    const many = Array.from({ length: 60 }, () => ({
      at: 1,
      kind: 'info' as const,
      text: big,
    }))
    for (let i = 0; i < 8; i++) {
      await recordFinishedRun({
        runId: `run-${i}`,
        source: 'manual',
        outcome: 'ok',
        finishedAt: 2000 + i,
        steps: many,
      })
    }

    const stored = data.get(KEY_RUNS) as { id: string }[]
    const bytes = JSON.stringify(stored).length
    expect(bytes).toBeLessThan(1_600_000)
    // The newest run is never the victim, and the log is not emptied.
    expect(stored[0]!.id).toBe('run-7')
    expect(stored.length).toBeLessThan(8)
    expect(stored.length).toBeGreaterThan(0)
  })
})

/**
 * The handoff: what a run publishes for the task that follows it. Every value
 * here is read back by a later run, possibly after the worker that wrote it is
 * gone, so the store boundary is where the caps have to bite.
 */
describe('run log handoff outputs', () => {
  it('round-trips the declared outputs to the next reader', async () => {
    await recordFinishedRun({
      runId: 'run-handoff',
      taskId: 'parent',
      source: 'schedule',
      outcome: 'ok',
      summary: 'Published.',
      outputs: { noteUrl: 'https://xhs/1', title: 'Note' },
    })

    const [run] = await listRuns('parent')
    expect(run?.outputs).toEqual({ noteUrl: 'https://xhs/1', title: 'Note' })
  })

  it('never persists a credential that rode in the variable bag', async () => {
    await recordFinishedRun({
      runId: 'run-secret',
      taskId: 'parent',
      source: 'schedule',
      outcome: 'ok',
      outputs: { cookie: 'session-value', noteUrl: 'https://xhs/1' },
    })

    expect(JSON.stringify(data.get(KEY_RUNS))).not.toContain('session-value')
    const [run] = await listRuns('parent')
    expect(run?.outputs).toEqual({ noteUrl: 'https://xhs/1' })
  })

  it('caps each value and the whole bag instead of trusting the producer', async () => {
    await recordFinishedRun({
      runId: 'run-fat',
      taskId: 'parent',
      source: 'schedule',
      outcome: 'ok',
      outputs: {
        body: 'x'.repeat(40_000),
        wide: 'y'.repeat(MAX_OUTPUT_STRING),
        wide2: 'z'.repeat(MAX_OUTPUT_STRING),
      },
    })

    const stored = data.get(KEY_RUNS) as { id: string; outputs?: Record<string, string> }[]
    const record = stored.find((run) => run.id === 'run-fat')!
    expect(record.outputs?.['body']).toContain('not persisted')
    expect(JSON.stringify(record.outputs).length).toBeLessThanOrEqual(MAX_RUN_OUTPUTS_BYTES + 256)
    // The reader re-caps what it reads (an older record may predate the cap), so
    // a bulk value arrives short and self-describing rather than identical.
    const [run] = await listRuns('parent')
    expect(run?.outputs?.['body']).toContain('not persisted')
    expect((run?.outputs?.['body'] as string).length).toBeLessThan(MAX_OUTPUT_STRING + 120)
    expect(run?.outputs?.['wide']).toBe('y'.repeat(MAX_OUTPUT_STRING))
  })

  it('leaves an older record without outputs readable', async () => {
    data.set(KEY_RUNS, [
      {
        id: 'legacy-outputs',
        taskId: 'parent',
        trigger: 'manual',
        source: 'manual',
        at: 1,
        ok: true,
        skipped: false,
        outcome: 'ok',
        summary: '',
      },
    ])
    const [run] = await listRuns('parent')
    expect(run?.id).toBe('legacy-outputs')
    expect(run?.outputs).toBeUndefined()
  })
})
