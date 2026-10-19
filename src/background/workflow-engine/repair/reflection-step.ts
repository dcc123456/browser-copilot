/**
 * Reflection step shared by the patch-and-retry loops.
 *
 * `generation-repair` re-proposes after a failed round and used to hand the
 * proposer a context with an empty `repairHistory` — the round that just failed
 * taught it nothing. It now records a reflection per failed round and reads it
 * back on the next proposal.
 *
 * Reachability: `finalizeGeneratedWorkflow` currently has no production caller
 * (generated workflows are finalized through the auto-repair ladder — see
 * `specs/2026-10-19-repair-reflection-design.md` §1.1). The live reflection
 * implementation today is the ladder's `makeReflect` in `auto-repair/`.
 *
 * Everything here is failure-tolerant by construction: a missing provider or a
 * thrown call both yield `undefined`, and the caller then proposes exactly as
 * it did before reflections existed.
 *
 * @module background/workflow-engine/repair/reflection-step
 */
import type { RepairReflection } from '../../../lib/workflow/repair-reflection'
import type { RepairRoundSummary } from '../../../lib/workflow/repair/types'
import type { Workflow } from '../../../lib/workflow/types'

/** Produces a reflection for one failed round, or `undefined` when it cannot. */
export type ReflectionRunner = (
  input: ReflectionRunnerInput,
) => Promise<RepairReflection | undefined>

export interface ReflectionRunnerInput {
  workflow: Workflow
  failedNodeId: string
  /** The classified failure that started this repair. */
  failureType: string
  originalFailure: string
  /** What the round just past did, and why it still failed. */
  attemptedStrategy: string
  attemptedReason?: string
  outcome: string
  /** Rounds already finished, oldest first. */
  history: RepairRoundSummary[]
}

/** Append a finished round to the history the next proposal reads. */
export function recordRound(
  history: RepairRoundSummary[],
  round: Omit<RepairRoundSummary, 'round'>,
): RepairRoundSummary[] {
  return [...history, { ...round, round: history.length + 1 }]
}

/**
 * Run one reflection, absorbing every failure mode.
 *
 * Skipped outright when no round can follow it (the conclusion would be read by
 * nobody) and when the deadline has already passed — a reflection that lands
 * after the budget is spent is a paid-for line nobody reads.
 */
export async function reflectOnFailedRound(
  run: ReflectionRunner | undefined,
  input: ReflectionRunnerInput,
  options: { hasRoundLeft: boolean; expired: boolean },
): Promise<RepairReflection | undefined> {
  if (!run || !options.hasRoundLeft || options.expired) return undefined
  try {
    return await run(input)
  } catch {
    return undefined
  }
}
