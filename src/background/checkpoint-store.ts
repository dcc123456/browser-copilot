/**
 * M4 · Durable checkpoint store for the extension.
 *
 * `lib/workflow/checkpoints.ts` defines the FORMAT and the pure helpers; this
 * module is the chrome/file-backed persistence behind it. It goes through the
 * shared `fileStorageArea()` (see `lib/fs-store.ts`), so checkpoints land in
 * `checkpoints/<runId>.json` when the user configured a data directory and in
 * `chrome.storage.local` otherwise — one code path, both backends.
 *
 * Reads stay SYNCHRONOUS (the `CheckpointStore` interface) because the engine's
 * rollback path needs a checkpoint without awaiting I/O mid-step. The durable
 * copy is written fire-and-forget: a service worker can be evicted between any
 * two events, so a slow write must never block or fail a run.
 *
 * @module background/checkpoint-store
 */
import { CHECKPOINT_PREFIX, fileStorageArea, type StorageArea } from '../lib/fs-store'
import type { CheckpointStore, RunCheckpoint } from '../lib/workflow/checkpoints'

/** Per-run cap on retained checkpoints (a long run must not grow unbounded). */
const DEFAULT_LIMIT = 50

/** How many finished runs keep their checkpoints on disk. */
const DEFAULT_MAX_PERSISTED_RUNS = 20

/** Storage key of one run's checkpoints. */
export function checkpointKey(runId: string): string {
  return `${CHECKPOINT_PREFIX}${runId}`
}

/** Narrows an unknown persisted value to a checkpoint array. */
function asCheckpoints(value: unknown): RunCheckpoint[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is RunCheckpoint =>
      !!entry && typeof entry === 'object' && typeof (entry as RunCheckpoint).runId === 'string',
  )
}

export interface ChromeCheckpointStoreOptions {
  /** Per-run checkpoint cap. */
  limit?: number
  /** Injected storage area (tests pass a fake; default: `fileStorageArea()`). */
  area?: StorageArea
}

/**
 * A checkpoint store that keeps the HOT path in memory and mirrors every write
 * to durable storage. `load`/`latest`/`clear` are synchronous (in-memory); the
 * durable copy is for crash/restart recovery and is read back explicitly with
 * {@link readPersistedCheckpoints}.
 */
export function createChromeCheckpointStore(
  options: ChromeCheckpointStoreOptions = {},
): CheckpointStore {
  const limit = options.limit ?? DEFAULT_LIMIT
  const area = options.area ?? fileStorageArea()
  const byRun = new Map<string, RunCheckpoint[]>()
  /** Coalesces bursts of step writes into one storage call per tick. */
  const pending = new Set<string>()
  let flushScheduled = false

  const flush = (): void => {
    flushScheduled = false
    const runIds = [...pending]
    pending.clear()
    for (const runId of runIds) {
      const list = byRun.get(runId) ?? []
      // A failed write must never break the run: checkpoints are an
      // optimization, not a correctness requirement.
      void area.set({ [checkpointKey(runId)]: list }).catch(() => undefined)
    }
  }

  const schedule = (runId: string): void => {
    pending.add(runId)
    if (flushScheduled) return
    flushScheduled = true
    // Defer to the next macrotask so all steps of a synchronous burst are
    // written once, not once per step.
    setTimeout(flush, 0)
  }

  return {
    save(cp) {
      const list = byRun.get(cp.runId) ?? []
      list.push(cp)
      if (list.length > limit) list.splice(0, list.length - limit)
      byRun.set(cp.runId, list)
      schedule(cp.runId)
    },
    load(runId) {
      return (byRun.get(runId) ?? []).map((cp) => ({ ...cp }))
    },
    latest(runId) {
      const list = byRun.get(runId)
      return list && list.length > 0 ? { ...list[list.length - 1]! } : undefined
    },
    clear(runId) {
      byRun.delete(runId)
      pending.delete(runId)
      void area.remove(checkpointKey(runId)).catch(() => undefined)
    },
  }
}

/**
 * Async: reads a run's checkpoints back from durable storage — the recovery
 * path after a service-worker restart (the in-memory cache is gone by then).
 */
export async function readPersistedCheckpoints(
  runId: string,
  area: StorageArea = fileStorageArea(),
): Promise<RunCheckpoint[]> {
  try {
    const stored = await area.get(checkpointKey(runId))
    return asCheckpoints(stored[checkpointKey(runId)])
  } catch {
    return []
  }
}

/** Async: drops a run's persisted checkpoints. */
export async function clearPersistedCheckpoints(
  runId: string,
  area: StorageArea = fileStorageArea(),
): Promise<void> {
  try {
    await area.remove(checkpointKey(runId))
  } catch {
    // Ignore: nothing durable to remove.
  }
}

/**
 * Async: keeps only the newest `keep` runs' checkpoints on disk, so repeated
 * debugging does not fill the data directory. Call it at the end of a run.
 */
export async function prunePersistedCheckpoints(
  keep = DEFAULT_MAX_PERSISTED_RUNS,
  area: StorageArea = fileStorageArea(),
): Promise<number> {
  let removed = 0
  try {
    // chrome.storage.local has no prefix scan, but the file area is a
    // superset: both are read through the same `get(keys)` API, and the caller
    // supplies the known run ids. Unknown ids are simply left alone.
    const stored = await area.get(CHECKPOINT_PREFIX)
    const value = stored[CHECKPOINT_PREFIX]
    const runIds: string[] =
      Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? (value as string[])
        : []
    if (runIds.length <= keep) return 0
    const stale = runIds.slice(0, Math.max(0, runIds.length - keep))
    for (const runId of stale) {
      await area.remove(checkpointKey(runId))
      removed += 1
    }
    await area.set({ [CHECKPOINT_PREFIX]: runIds.slice(-keep) })
  } catch {
    return removed
  }
  return removed
}

/** Registers a run id in the persisted-run index used by the pruner. */
export async function indexPersistedRun(
  runId: string,
  area: StorageArea = fileStorageArea(),
): Promise<void> {
  try {
    const stored = await area.get(CHECKPOINT_PREFIX)
    const value = stored[CHECKPOINT_PREFIX]
    const runIds: string[] =
      Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? (value as string[])
        : []
    if (runIds.includes(runId)) return
    runIds.push(runId)
    await area.set({ [CHECKPOINT_PREFIX]: runIds })
  } catch {
    // Ignore: the index is an optimization for pruning.
  }
}
