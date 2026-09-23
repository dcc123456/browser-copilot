/**
 * Workflow health summary (spec §22 · Commit 15).
 *
 * Turns the LOCAL run history for one workflow into an understandable health
 * line. There is deliberately no opaque "AI score": every number is a count of
 * real runs the user can see in the History tab.
 *
 * ```text
 * status: stable | needs-attention | no-data
 * 9 / 10 runs passed
 * last verified: <timestamp of the newest successful run>
 * last failed category: LOCATOR (when relevant)
 * recovery: 1 repaired · 1 resumed (when relevant)
 * ```
 *
 * Only workflow runs (`workflowId` set) for the requested workflow count, and
 * intentionally skipped runs are excluded from the pass ratio (they are not a
 * pass or a failure). The window is the most recent {@link HEALTH_WINDOW} runs
 * so a fixed old failure does not brand the workflow forever.
 *
 * Pure module: no storage, no DOM.
 *
 * @module lib/workflow/workflow-health
 */

import type { TaskRunLog } from '../scheduler-types'

/** Number of most-recent runs summarized for health. */
export const HEALTH_WINDOW = 10

export type WorkflowHealthStatus = 'stable' | 'needs-attention' | 'no-data'

export interface WorkflowHealthSummary {
  status: WorkflowHealthStatus
  /** Runs counted in the window (excluding skipped). */
  totalRuns: number
  passedRuns: number
  /** Timestamp of the newest successful run, when one exists. */
  lastVerifiedAt?: number
  /** Failure category of the most recent failed run, when present. */
  lastFailureCategory?: string
  /** Count of runs that completed after an AI repair. */
  repairedRuns: number
  /** Count of runs that completed after resuming from a checkpoint. */
  resumedRuns: number
}

/** Whether a run log is an execution of the given workflow. */
function isRunOf(workflowId: string, run: TaskRunLog): boolean {
  return run.workflowId === workflowId
}

/** A run that should count in the ratio: not intentionally skipped. */
function isCounted(run: TaskRunLog): boolean {
  return run.skipped !== true
}

function runTime(run: TaskRunLog): number {
  return run.finishedAt ?? run.startedAt ?? run.at
}

/**
 * Summarize the health of one workflow from its local run history.
 *
 * Runs are sorted newest-first, the window taken, then counted. A workflow with
 * no counted run is `no-data`; one whose window passes every counted run is
 * `stable`; otherwise `needs-attention`.
 */
export function summarizeWorkflowHealth(
  runs: readonly TaskRunLog[],
  workflowId: string,
): WorkflowHealthSummary {
  const own = runs
    .filter((run) => isRunOf(workflowId, run))
    .sort((a, b) => runTime(b) - runTime(a))

  const windowRuns = own.slice(0, HEALTH_WINDOW)
  const counted = windowRuns.filter(isCounted)

  const passedRuns = counted.filter((run) => run.ok).length

  const newestPassed = counted.find((run) => run.ok)
  const newestFailed = counted.find((run) => !run.ok)

  const repairedRuns = counted.filter((run) => run.repaired === true).length
  const resumedRuns = counted.filter((run) => run.resumed === true).length

  if (counted.length === 0) {
    return {
      status: 'no-data',
      totalRuns: 0,
      passedRuns: 0,
      repairedRuns,
      resumedRuns,
    }
  }

  const status: WorkflowHealthStatus =
    passedRuns === counted.length ? 'stable' : 'needs-attention'

  return {
    status,
    totalRuns: counted.length,
    passedRuns,
    ...(newestPassed ? { lastVerifiedAt: runTime(newestPassed) } : {}),
    ...(newestFailed?.failureCategory
      ? { lastFailureCategory: newestFailed.failureCategory }
      : {}),
    repairedRuns,
    resumedRuns,
  }
}
