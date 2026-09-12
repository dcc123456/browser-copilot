/**
 * M4 · Durable checkpoint store for the server runner (Node).
 *
 * The server shares the pure `CheckpointStore` contract and the
 * `RunCheckpoint` format with the extension, but backs it with real files:
 * `<dataDir>/checkpoints/checkpoint-<runId>.json`. Same shape as the
 * extension's `checkpoints/<runId>.json`, so a checkpoint written by one side
 * is readable by the other.
 *
 * Reads are synchronous (the contract) and served from an in-memory map; the
 * durable write is fire-and-forget, because a checkpoint must never slow down
 * or fail the run it is describing.
 *
 * @module server/checkpoint-store
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  checkpointFileName,
  type CheckpointStore,
  type RunCheckpoint,
} from '../../src/lib/workflow/checkpoints'

export type { CheckpointStore, RunCheckpoint }

/** Per-run cap on retained checkpoints (a long run must not grow unbounded). */
const DEFAULT_LIMIT = 50

/** How many finished runs keep their checkpoint files on disk. */
export const DEFAULT_MAX_PERSISTED_RUNS = 20

/** Absolute path of one run's checkpoint file. */
export function checkpointPath(dir: string, runId: string): string {
  return join(dir, checkpointFileName(runId))
}

function asCheckpoints(raw: string): RunCheckpoint[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is RunCheckpoint =>
        !!entry && typeof entry === 'object' && typeof (entry as RunCheckpoint).runId === 'string',
    )
  } catch {
    return []
  }
}

/**
 * A file-backed checkpoint store. `save` updates the in-memory list and
 * schedules a write; `load`/`latest`/`clear` are synchronous.
 */
export function createFileCheckpointStore(dir: string, limit = DEFAULT_LIMIT): CheckpointStore {
  const byRun = new Map<string, RunCheckpoint[]>()
  const pending = new Set<string>()
  let scheduled = false

  const flush = (): void => {
    scheduled = false
    const runIds = [...pending]
    pending.clear()
    for (const runId of runIds) {
      const list = byRun.get(runId) ?? []
      void (async () => {
        try {
          await mkdir(dir, { recursive: true })
          await writeFile(checkpointPath(dir, runId), JSON.stringify(list), 'utf8')
        } catch {
          // Checkpoints are an optimization, never a correctness requirement.
        }
      })()
    }
  }

  const schedule = (runId: string): void => {
    pending.add(runId)
    if (scheduled) return
    scheduled = true
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
      void rm(checkpointPath(dir, runId), { force: true }).catch(() => undefined)
    },
  }
}

/** Reads a run's checkpoints back from disk (recovery after a restart). */
export async function readPersistedCheckpoints(
  dir: string,
  runId: string,
): Promise<RunCheckpoint[]> {
  try {
    return asCheckpoints(await readFile(checkpointPath(dir, runId), 'utf8'))
  } catch {
    return []
  }
}

/**
 * Retires the oldest checkpoint files, keeping the newest `keep` runs, so a
 * long-lived server does not accumulate one file per run forever.
 */
export async function pruneCheckpointDir(
  dir: string,
  keep = DEFAULT_MAX_PERSISTED_RUNS,
): Promise<number> {
  let removed = 0
  try {
    const entries = await readdir(dir)
    const files = entries.filter((name) => name.startsWith('checkpoint-') && name.endsWith('.json'))
    if (files.length <= keep) return 0
    // File names embed no timestamp, so order by mtime (oldest first).
    const withTime = await Promise.all(
      files.map(async (name) => {
        try {
          const info = await stat(join(dir, name))
          return { name, mtimeMs: info.mtimeMs }
        } catch {
          return { name, mtimeMs: 0 }
        }
      }),
    )
    withTime.sort((a, b) => a.mtimeMs - b.mtimeMs)
    const stale = withTime.slice(0, Math.max(0, withTime.length - keep))
    for (const entry of stale) {
      await rm(join(dir, entry.name), { force: true })
      removed += 1
    }
  } catch {
    return removed
  }
  return removed
}
