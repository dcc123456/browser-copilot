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
import type { Workflow } from './types'

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

/** Where a crashed or interrupted run can pick up again. */
export interface ResumePoint {
  /** The node to START FROM (the one after the last clean step). */
  nodeId: string
  /** Variables as they were at the last clean step. */
  variables: Record<string, unknown>
  /** The checkpoint the point was derived from (logging / display). */
  fromStepIndex: number
}

/**
 * Derives where a run can resume: the node AFTER the last step that settled
 * cleanly, carrying that step's variables.
 *
 * This is what makes a NON-IDEMPOTENT flow recoverable. Re-running a login
 * workflow from its trigger re-drives the login — but the user is already
 * logged in, so the form is gone and the retry can only fail. Resuming from
 * the last clean step skips the part that already happened.
 *
 * Returns undefined when there is nothing to resume: no clean step, a node
 * that no longer exists in the graph, or a clean step with no downstream
 * (the run had effectively finished).
 *
 * Pure: no chrome, no fs, no engine.
 */
export function resumePointOf(
  workflow: Workflow,
  checkpoints: RunCheckpoint[],
): ResumePoint | undefined {
  // Newest clean step wins — the furthest point the run provably reached.
  for (let i = checkpoints.length - 1; i >= 0; i -= 1) {
    const cp = checkpoints[i]!
    if (cp.status !== 'ok' || !cp.nodeId) continue
    const node = workflow.drawflow.nodes.find((n) => n.id === cp.nodeId)
    if (!node) continue
    const out = workflow.drawflow.edges.filter((edge) => edge.source === node.id)
    if (out.length === 0) return undefined
    // Mirror the engine's default routing: the plain/default edge, not a
    // branch handle (fallback / condition outputs).
    const next = out.find((edge) => !edge.sourceHandle || edge.sourceHandle === 'next') ?? out[0]!
    return {
      nodeId: next.target,
      variables: restoreVariables(cp),
      fromStepIndex: cp.stepIndex,
    }
  }
  return undefined
}
