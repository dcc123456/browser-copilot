/**
 * Tests for the extension's durable checkpoint store
 * (`background/checkpoint-store`):
 *  - the synchronous in-memory half (what the rollback path reads);
 *  - the fire-and-forget durable half, written through an injected area;
 *  - read-back after a restart, and pruning of the oldest runs.
 *
 * The real area (`fileStorageArea()`) is never touched: a fake is injected, so
 * these tests run in plain Node with no chrome and no filesystem.
 */
import { describe, expect, it } from 'vitest'

import {
  checkpointKey,
  clearPersistedCheckpoints,
  createChromeCheckpointStore,
  indexPersistedRun,
  prunePersistedCheckpoints,
  readPersistedCheckpoints,
} from '../src/background/checkpoint-store'
import { CHECKPOINT_PREFIX } from '../src/lib/fs-store'
import type { StorageArea } from '../src/lib/fs-store'
import type { RunCheckpoint } from '../src/lib/workflow/checkpoints'

/** An in-process StorageArea, so the tests stay hermetic. */
function fakeArea(): StorageArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys]
      const out: Record<string, unknown> = {}
      for (const key of list) if (data.has(key)) out[key] = data.get(key)
      return out
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value)
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key)
    },
  }
}

const cp = (runId: string, stepIndex: number, status: RunCheckpoint['status']): RunCheckpoint => ({
  runId,
  stepIndex,
  nodeId: `n${stepIndex}`,
  status,
  variables: { step: stepIndex },
  at: 1000 + stepIndex,
})

/** Lets the store's deferred (setTimeout 0) write land. */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 5))
  await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('createChromeCheckpointStore', () => {
  it('serves save/load/latest synchronously from memory', () => {
    const store = createChromeCheckpointStore({ area: fakeArea() })
    expect(store.latest('r1')).toBeUndefined()

    store.save(cp('r1', 0, 'ok'))
    store.save(cp('r1', 1, 'failed'))

    expect(store.load('r1')).toHaveLength(2)
    expect(store.latest('r1')).toMatchObject({ stepIndex: 1, status: 'failed' })
    // A different run is a different list.
    expect(store.load('r2')).toEqual([])
  })

  it('caps retained checkpoints per run', () => {
    const store = createChromeCheckpointStore({ area: fakeArea(), limit: 3 })
    for (let i = 0; i < 10; i++) store.save(cp('r1', i, 'ok'))
    const list = store.load('r1')
    expect(list).toHaveLength(3)
    // The NEWEST survive: older ones roll off.
    expect(list.map((entry) => entry.stepIndex)).toEqual([7, 8, 9])
  })

  it('clear drops both the memory and the durable copy', async () => {
    const area = fakeArea()
    const store = createChromeCheckpointStore({ area })
    store.save(cp('r1', 0, 'ok'))
    await flush()
    expect(area.data.has(checkpointKey('r1'))).toBe(true)

    store.clear('r1')
    expect(store.load('r1')).toEqual([])
    await flush()
    expect(area.data.has(checkpointKey('r1'))).toBe(false)
  })
})

describe('durable checkpoint persistence', () => {
  it('writes every step of a run through the injected area', async () => {
    const area = fakeArea()
    const store = createChromeCheckpointStore({ area })
    // A burst of steps must not cost one storage call each.
    store.save(cp('r1', 0, 'ok'))
    store.save(cp('r1', 1, 'ok'))
    store.save(cp('r1', 2, 'failed'))
    expect(area.data.size).toBe(0)
    await flush()

    const persisted = await readPersistedCheckpoints('r1', area)
    expect(persisted.map((entry) => entry.stepIndex)).toEqual([0, 1, 2])
    expect(persisted[2]).toMatchObject({ status: 'failed', variables: { step: 2 } })
  })

  it('readPersistedCheckpoints survives an empty/invalid payload', async () => {
    const area = fakeArea()
    await area.set({ [checkpointKey('r1')]: 'not-an-array' })
    expect(await readPersistedCheckpoints('r1', area)).toEqual([])
    expect(await readPersistedCheckpoints('missing', area)).toEqual([])
  })

  it('clearPersistedCheckpoints removes only that run', async () => {
    const area = fakeArea()
    await area.set({ [checkpointKey('r1')]: [cp('r1', 0, 'ok')] })
    await area.set({ [checkpointKey('r2')]: [cp('r2', 0, 'ok')] })
    await clearPersistedCheckpoints('r1', area)
    expect(area.data.has(checkpointKey('r1'))).toBe(false)
    expect(area.data.has(checkpointKey('r2'))).toBe(true)
  })

  it('prunes the oldest indexed runs, keeping the newest', async () => {
    const area = fakeArea()
    for (const runId of ['r1', 'r2', 'r3', 'r4']) {
      await indexPersistedRun(runId, area)
      await area.set({ [checkpointKey(runId)]: [cp(runId, 0, 'ok')] })
    }
    expect(await readPersistedCheckpoints('r1', area)).toHaveLength(1)

    const removed = await prunePersistedCheckpoints(2, area)
    expect(removed).toBe(2)
    // The two oldest are gone, the two newest survive.
    expect(area.data.has(checkpointKey('r1'))).toBe(false)
    expect(area.data.has(checkpointKey('r2'))).toBe(false)
    expect(area.data.has(checkpointKey('r3'))).toBe(true)
    expect(area.data.has(checkpointKey('r4'))).toBe(true)
    // The index itself is trimmed.
    expect(area.data.get(CHECKPOINT_PREFIX)).toEqual(['r3', 'r4'])
  })

  it('pruning is a no-op below the retention threshold', async () => {
    const area = fakeArea()
    await indexPersistedRun('r1', area)
    expect(await prunePersistedCheckpoints(20, area)).toBe(0)
    expect(area.data.get(CHECKPOINT_PREFIX)).toEqual(['r1'])
  })

  it('indexing the same run twice does not duplicate it', async () => {
    const area = fakeArea()
    await indexPersistedRun('r1', area)
    await indexPersistedRun('r1', area)
    expect(area.data.get(CHECKPOINT_PREFIX)).toEqual(['r1'])
  })
})
