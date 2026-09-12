/**
 * M4 · Local checkpoints + state rollback (plan items 10/11/16/17).
 *
 * The engine has a step budget but NO resume point: a crash or a service-worker
 * restart replays the whole run from zero. This module keeps a cheap, local
 * checkpoint per step so a run can be resumed — or rolled back to the last
 * known-good state — without re-driving the browser.
 *
 * Deliberately NOT an external workflow engine (no Temporal): storage is an
 * injected interface, so the extension can back it with `chrome.storage.local`
 * and the server with `checkpoints/<runId>.json`, sharing this format.
 *
 * Everything here is pure and synchronous: no `chrome.*`, no `node:fs`.
 *
 * @module lib/workflow/checkpoints
 */

/** Lifecycle status of one checkpoint. */
export type CheckpointStatus = 'running' | 'ok' | 'failed' | 'cancelled'

/** One recorded step of a run — the shared extension/server format. */
export interface RunCheckpoint {
  runId: string
  workflowId?: string
  /** 0-based index of the step within the run. */
  stepIndex: number
  nodeId?: string
  status: CheckpointStatus
  variables: Record<string, unknown>
  /** Compact page/URL summary (cheap: a string, not a full snapshot). */
  pageState?: string
  /** Short agent memory notes carried across retries. */
  agentMemory?: string[]
  at: number
}

/** Storage contract. Implementations may be in-memory, chrome.storage or fs. */
export interface CheckpointStore {
  save(cp: RunCheckpoint): void
  load(runId: string): RunCheckpoint[]
  latest(runId: string): RunCheckpoint | undefined
  clear(runId: string): void
}

/** Per-run cap on retained checkpoints (a long run must not grow unbounded). */
const DEFAULT_LIMIT = 50

/**
 * In-memory checkpoint store (default; the extension/server wrap a durable
 * backend when they want checkpoints to survive a restart).
 */
export function createMemoryCheckpointStore(limit = DEFAULT_LIMIT): CheckpointStore {
  const byRun = new Map<string, RunCheckpoint[]>()
  return {
    save(cp) {
      const list = byRun.get(cp.runId) ?? []
      list.push(cp)
      if (list.length > limit) list.splice(0, list.length - limit)
      byRun.set(cp.runId, list)
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
    },
  }
}

/** File name for a run's checkpoint inside `checkpoints/` (shared convention). */
export function checkpointFileName(runId: string): string {
  return `checkpoint-${runId}.json`
}

/** Records one checkpoint. Ignores an entry without a runId. */
export function recordCheckpoint(store: CheckpointStore, cp: RunCheckpoint): void {
  if (!cp.runId) return
  store.save(cp)
}

/**
 * Rolls back to the last VALID checkpoint of a run: the newest entry that is
 * not `failed`/`cancelled`. Returns undefined when the run has no valid point
 * (caller then replays from the start).
 */
export function rollbackToLastValid(
  store: CheckpointStore,
  runId: string,
): RunCheckpoint | undefined {
  const list = store.load(runId)
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const cp = list[i]!
    if (cp.status !== 'failed' && cp.status !== 'cancelled') return cp
  }
  return undefined
}

/** Restores the run's variables from a checkpoint (empty object when none). */
export function restoreVariables(cp: RunCheckpoint | undefined): Record<string, unknown> {
  return cp ? { ...cp.variables } : {}
}
