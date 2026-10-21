/**
 * The goal verdict a generated workflow carries.
 *
 * The three-level verification (`background/workflow-engine/goal-verification`)
 * produces a verdict at RUN time, and the run side keeps it in the run log. The
 * workflow itself carried nothing, so a saved graph looked exactly as
 * trustworthy as one that had never been run — and the save card could not
 * tell "the steps ran" from "the goal was met".
 *
 * This module is the persisted shape of that verdict plus the guard that reads
 * it back. It lives in `lib/` because the settings whitelist
 * (`lib/workflow/storage.ts`) is the only reader of a persisted setting, and
 * `lib/` may not import the background engine.
 *
 * @module lib/workflow/goal-verification-record
 */

/** How far the verification got. `NONE` = nothing was judged. */
export type GoalVerificationLevel = 'L1' | 'L2' | 'L3' | 'NONE'

/** The verdict a workflow carries. Evidence, never a gate. */
export interface WorkflowGoalVerification {
  /** The level the verdict came from. */
  level: GoalVerificationLevel
  /** Whether the goal was met. */
  certified: boolean
  /** Why — one line, the same wording the run side reports. */
  reason: string
  /** The goal rows that did not hold. Empty when the goal was met. */
  unmet: string[]
}

const LEVELS: readonly GoalVerificationLevel[] = ['L1', 'L2', 'L3', 'NONE']

/**
 * Read a persisted verdict back, or nothing when the stored value is not one.
 *
 * A malformed record is DROPPED, not repaired: a half-understood verdict is
 * worse than an absent one, because an absent one means "not judged" and a
 * repaired one means "judged, and this is what it said".
 */
export function normalizeGoalVerification(raw: unknown): WorkflowGoalVerification | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const level = value['level']
  if (!LEVELS.includes(level as GoalVerificationLevel)) return undefined
  const unmet = Array.isArray(value['unmet'])
    ? value['unmet'].filter((row): row is string => typeof row === 'string')
    : []
  return {
    level: level as GoalVerificationLevel,
    certified: value['certified'] === true,
    reason: typeof value['reason'] === 'string' ? value['reason'] : '',
    unmet,
  }
}
