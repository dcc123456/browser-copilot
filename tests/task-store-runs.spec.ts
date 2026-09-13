/**
 * Tests for the run log's persistence round trip (`lib/task-store`):
 *
 *  - a finished run keeps its `workflowId` through a write and a read — the
 *    field is the only durable link from a run back to its workflow, so losing
 *    it on either side silently breaks "which run belongs to this workflow";
 *  - a record persisted before the field existed still parses, with only its
 *    label to go on;
 *  - a malformed id is dropped rather than trusted.
 *
 * `chrome.storage.local` is stubbed with an in-process map. In a plain Node run
 * `fileStorageArea()` resolves no directory handle, so it falls back to that
 * mirror — which is exactly the path under test. No chrome, no filesystem.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listRuns, recordFinishedRun } from '../src/lib/task-store'

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
