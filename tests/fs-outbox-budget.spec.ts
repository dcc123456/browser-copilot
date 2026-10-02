/**
 * Size bounds on the write outbox (`lib/fs-outbox`).
 *
 * The outbox is a SINGLE `chrome.storage.local` key holding every parked write,
 * and it is rewritten whole on every enqueue. Unbounded, one fat payload (a
 * run's checkpoints after a step that put base64 images into the variable bag)
 * turns each later enqueue into a multi-hundred-megabyte serialization that
 * kills the service worker mid-write — the data it was protecting dies with it.
 * These tests pin the two rules that replace that: an entry too big to park is
 * refused, and a full outbox sheds checkpoints before transcripts before
 * anything structural, never the write that just arrived.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CACHE_INDEX_KEY,
  CACHE_PREFIX,
  OUTBOX_KEY,
  clearFallbacks,
  dropOutboxEntry,
  enqueueOutbox,
  readOutboxMap,
  replayOutbox,
  trimOutboxToBudget,
  writeCache,
} from '../src/lib/fs-outbox'

/** `x` characters of payload, JSON-serialized a little larger. */
const payload = (chars: number): { blob: string } => ({ blob: 'x'.repeat(chars) })

/** One entry comfortably under the per-entry budget. */
const FILLER = 1_700_000

let store: Map<string, unknown>
/** Ordered `area:key` operations, so "never read it back" is provable. */
let ops: string[]
let writes: number

function makeChromeMock(sizeInBytes?: number): void {
  store = new Map<string, unknown>()
  ops = []
  writes = 0
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        async get(keys: string | string[] | null) {
          const list = keys === null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys]
          for (const key of list) ops.push(`get:${key}`)
          const out: Record<string, unknown> = {}
          for (const key of list) if (store.has(key)) out[key] = store.get(key)
          return out
        },
        async set(items: Record<string, unknown>) {
          writes += 1
          for (const key of Object.keys(items)) ops.push(`set:${key}`)
          for (const [key, value] of Object.entries(items)) store.set(key, value)
        },
        async remove(keys: string | string[]) {
          writes += 1
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            ops.push(`remove:${key}`)
            store.delete(key)
          }
        },
        async getBytesInUse(key?: string | null) {
          if (typeof key === 'string' && key === OUTBOX_KEY && sizeInBytes !== undefined) {
            return sizeInBytes
          }
          return 0
        },
      },
    },
  })
}

const parkedKeys = async (): Promise<string[]> =>
  Object.keys(await readOutboxMap()).sort()

beforeEach(() => {
  makeChromeMock()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fs-outbox size budget', () => {
  it('refuses a payload too large to park instead of rewriting the map with it', async () => {
    await enqueueOutbox('cp:run-a', payload(FILLER))
    await enqueueOutbox('cp:run-b', payload(2_500_000))

    expect(await parkedKeys()).toEqual(['cp:run-a'])
    // The refused write is the ONLY loss — the buffer it would have destroyed
    // still holds everything it already carried.
    expect((await readOutboxMap())['cp:run-a']?.value).toEqual(payload(FILLER))
  })

  it('sheds checkpoints before transcripts before structural keys', async () => {
    await enqueueOutbox('cp:run-a', payload(FILLER))
    await enqueueOutbox('cp:run-b', payload(FILLER))
    await enqueueOutbox('conv:c1', payload(FILLER))
    await enqueueOutbox('conv:c2', payload(FILLER))
    // The fifth entry pushes the map past its budget.
    await enqueueOutbox('workflows', payload(FILLER))

    const parked = await parkedKeys()
    expect(parked).toContain('workflows')
    expect(parked).not.toContain('cp:run-a')
    // Nothing but the cheapest class was spent, and never the fresh entry.
    expect(parked).toEqual(['conv:c1', 'conv:c2', 'cp:run-b', 'workflows'])
  })

  it('keeps read-modify-write starting from the newest state of a surviving key', async () => {
    await enqueueOutbox('workflows', { list: ['first'] })
    await enqueueOutbox('workflows', { list: ['first', 'second'] })

    const entry = (await readOutboxMap())['workflows']
    expect(entry?.value).toEqual({ list: ['first', 'second'] })
    expect(await parkedKeys()).toEqual(['workflows'])
  })

  it('replays what survived and drops what it landed', async () => {
    await enqueueOutbox('workflows', { list: ['a'] })
    await enqueueOutbox('cp:run-a', payload(FILLER))

    const landed: string[] = []
    await replayOutbox({
      async writeEntry(key, value) {
        landed.push(key)
        expect(value).toBeDefined()
      },
    })

    expect(landed.sort()).toEqual(['cp:run-a', 'workflows'])
    expect(await parkedKeys()).toEqual([])
    expect(store.has(OUTBOX_KEY)).toBe(true)

    // A tombstone is a write too, and it drains the same way.
    await dropOutboxEntry('workflows')
    await enqueueOutbox('workflows', null)
    const deleted: string[] = []
    await replayOutbox({
      async writeEntry(key) {
        deleted.push(key)
      },
    })
    expect(deleted).toEqual(['workflows'])
  })
})

/**
 * The same buffer left behind by a build WITHOUT the cap: the store still holds
 * it, and the next session dies reading it over and over — the writes it parks
 * already failed once, so what it costs to shed is only the gap back to the last
 * state that landed on disk.
 */
describe('trimOutboxToBudget', () => {
  it('discards a buffer too large to read back, on the first touch, without reading it', async () => {
    makeChromeMock(300 * 1024 * 1024)
    store.set(OUTBOX_KEY, { 'cp:run-a': { value: payload(FILLER), at: 1 } })

    // Every reader is protected, not only the boot-time repair — a boot call
    // that loses the race against the other storage readers would save nothing.
    expect(await readOutboxMap()).toEqual({})
    expect(store.has(OUTBOX_KEY)).toBe(false)
    expect(ops).not.toContain(`get:${OUTBOX_KEY}`)
  })

  it('sheds the checkpoint entries a size-less map was holding', async () => {
    // Entries from the old build carry no `bytes`, and only the checkpoint class
    // is dropped on that basis — transcripts and collections are kept.
    store.set(OUTBOX_KEY, {
      'cp:run-a': { value: payload(FILLER), at: 1 },
      'conv:c1': { value: { messages: [1, 2, 3] }, at: 2 },
      workflows: { value: { list: ['a'] }, at: 3 },
    })

    await trimOutboxToBudget()

    expect(await parkedKeys()).toEqual(['conv:c1', 'workflows'])
  })

  it('leaves a healthy buffer exactly as it was', async () => {
    const map = { workflows: { value: { list: ['a'] }, at: 3, bytes: 20 } }
    store.set(OUTBOX_KEY, map)

    await trimOutboxToBudget()

    expect(writes).toBe(0)
    expect(store.get(OUTBOX_KEY)).toEqual(map)
  })
})

/**
 * Leaving file mode has to delete the fallback structures, and deleting them by
 * first listing the whole store means deserializing whatever the pre-budget
 * builds left in it — which is the read that kills the worker.
 */
describe('clearFallbacks', () => {
  it('removes every fallback key by name without reading the store whole', async () => {
    await enqueueOutbox('workflows', { list: ['a'] })
    await writeCache('conv:c1', payload(100))
    await writeCache('workflows', { list: ['a'] })
    await chrome.storage.local.set({ settings: { theme: 'dark' } })
    ops.length = 0

    await clearFallbacks()

    expect(ops).not.toContain('get:null')
    expect(store.has(OUTBOX_KEY)).toBe(false)
    expect(store.has(CACHE_INDEX_KEY)).toBe(false)
    expect(store.has(`${CACHE_PREFIX}conv:c1`)).toBe(false)
    expect(store.has(`${CACHE_PREFIX}workflows`)).toBe(false)
    // Not a fallback key, so not this call's business.
    expect(store.get('settings')).toEqual({ theme: 'dark' })
  })
})
