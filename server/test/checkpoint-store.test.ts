/**
 * Tests for the server runner's file-backed checkpoint store.
 *
 * The store is the Node half of M4: same `CheckpointStore` contract and
 * `RunCheckpoint` format as the extension, but persisted under
 * `<dir>/checkpoint-<runId>.json`. A real temp directory is used (no mocks):
 * the point of these tests is that the files really land on disk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkpointPath,
  createFileCheckpointStore,
  pruneCheckpointDir,
  readPersistedCheckpoints,
} from '../src/checkpoint-store'
import type { RunCheckpoint } from '../src/checkpoint-store'

let dir: string

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
  await new Promise((resolve) => setTimeout(resolve, 15))
  await new Promise((resolve) => setTimeout(resolve, 15))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bc-checkpoints-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createFileCheckpointStore', () => {
  it('serves load/latest synchronously and keeps runs apart', () => {
    const store = createFileCheckpointStore(dir)
    expect(store.latest('r1')).toBeUndefined()

    store.save(cp('r1', 0, 'ok'))
    store.save(cp('r1', 1, 'failed'))
    store.save(cp('r2', 0, 'ok'))

    expect(store.load('r1')).toHaveLength(2)
    expect(store.latest('r1')).toMatchObject({ stepIndex: 1, status: 'failed' })
    expect(store.load('r2')).toHaveLength(1)
  })

  it('caps retained checkpoints per run, keeping the newest', () => {
    const store = createFileCheckpointStore(dir, 3)
    for (let i = 0; i < 10; i++) store.save(cp('r1', i, 'ok'))
    expect(store.load('r1').map((entry) => entry.stepIndex)).toEqual([7, 8, 9])
  })

  it('writes the run to disk under checkpoint-<runId>.json', async () => {
    const store = createFileCheckpointStore(dir)
    store.save(cp('r1', 0, 'ok'))
    store.save(cp('r1', 1, 'failed'))
    await flush()

    const path = checkpointPath(dir, 'r1')
    expect(existsSync(path)).toBe(true)
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as RunCheckpoint[]
    expect(onDisk.map((entry) => entry.stepIndex)).toEqual([0, 1])
    expect(onDisk[1]).toMatchObject({ status: 'failed', variables: { step: 1 } })
  })

  it('clear removes both the memory and the file', async () => {
    const store = createFileCheckpointStore(dir)
    store.save(cp('r1', 0, 'ok'))
    await flush()
    expect(existsSync(checkpointPath(dir, 'r1'))).toBe(true)

    store.clear('r1')
    expect(store.load('r1')).toEqual([])
    await flush()
    expect(existsSync(checkpointPath(dir, 'r1'))).toBe(false)
  })
})

describe('readPersistedCheckpoints', () => {
  it('reads a run back after a restart (memory is gone)', async () => {
    const persisted = [cp('r1', 0, 'ok'), cp('r1', 1, 'ok')]
    writeFileSync(checkpointPath(dir, 'r1'), JSON.stringify(persisted), 'utf8')

    const read = await readPersistedCheckpoints(dir, 'r1')
    expect(read.map((entry) => entry.stepIndex)).toEqual([0, 1])
  })

  it('degrades to an empty list for a missing or corrupt file', async () => {
    expect(await readPersistedCheckpoints(dir, 'missing')).toEqual([])
    writeFileSync(checkpointPath(dir, 'bad'), '{not json', 'utf8')
    expect(await readPersistedCheckpoints(dir, 'bad')).toEqual([])
  })
})

describe('pruneCheckpointDir', () => {
  it('retires the oldest files, keeping the newest runs', async () => {
    for (let i = 0; i < 5; i++) {
      const path = checkpointPath(dir, `r${i}`)
      writeFileSync(path, JSON.stringify([cp(`r${i}`, 0, 'ok')]), 'utf8')
    }
    const removed = await pruneCheckpointDir(dir, 2)
    expect(removed).toBe(3)
    const left = ['r0', 'r1', 'r2', 'r3', 'r4'].filter((id) => existsSync(checkpointPath(dir, id)))
    // Ordering is by mtime; with same-tick writes the survivors are the last
    // two in sorted order — assert the count, not the exact ids.
    expect(left).toHaveLength(2)
  })

  it('is a no-op below the retention threshold', async () => {
    writeFileSync(checkpointPath(dir, 'r1'), '[]', 'utf8')
    expect(await pruneCheckpointDir(dir, 20)).toBe(0)
    expect(existsSync(checkpointPath(dir, 'r1'))).toBe(true)
  })

  it('survives a missing directory', async () => {
    expect(await pruneCheckpointDir(join(dir, 'nope'), 2)).toBe(0)
  })
})
