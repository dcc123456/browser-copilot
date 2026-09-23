/**
 * Dynamic repair budget (spec §11 · Commit 09).
 *
 * Allows, disallows and bounds recovery work by failure CATEGORY so the
 * orchestrator never spends model tokens or patches on the wrong failure:
 *
 *   - TRANSIENT classes (TIMING / NETWORK / NAVIGATION) → bounded RETRIES,
 *     no AI patch while a retry could still recover;
 *   - SIDE_EFFECT (side-effect-unknown)                  → no patch at all;
 *   - HUMAN-gated (AUTH / CAPTCHA)                      → no auto patch;
 *   - LOCATOR                                            → a FINITE number of
 *     AI patch rounds;
 *   - DATA                                               → bounded provide-data
 *     attempts, not structural patches;
 *   - STRUCTURAL                                         → a small bounded
 *     rebuild allowance.
 *
 * The tracker also detects NO IMPROVEMENT across rounds and stops early, so
 * repeated identical failures cannot burn the full budget.
 *
 * Pure module.
 *
 * @module lib/workflow/repair/dynamic-budget
 */

import type {
  FailureAnalysisV2,
  WorkflowFailureCategory,
} from './recovery-model'

export interface CategoryBudget {
  /** Bounded plain retries before any patch. */
  maxRetries: number
  /** Finite AI patch rounds. 0 forbids a patch. */
  maxPatchRounds: number
  /** Whether a patch is allowed at all for the category. */
  patchAllowed: boolean
  /** Whether a human must take over for any automatic action. */
  humanOnly: boolean
}

/**
 * Per-category budget table. Kept conservative: side-effect, auth and captcha
 * forbid patches; transient classes prefer retries.
 */
const CATEGORY_BUDGET: Record<WorkflowFailureCategory, CategoryBudget> = {
  TIMING: { maxRetries: 3, maxPatchRounds: 1, patchAllowed: true, humanOnly: false },
  NETWORK: { maxRetries: 3, maxPatchRounds: 1, patchAllowed: true, humanOnly: false },
  NAVIGATION: { maxRetries: 2, maxPatchRounds: 1, patchAllowed: true, humanOnly: false },
  PAGE_STATE: { maxRetries: 2, maxPatchRounds: 2, patchAllowed: true, humanOnly: false },
  LOCATOR: { maxRetries: 1, maxPatchRounds: 3, patchAllowed: true, humanOnly: false },
  DATA: { maxRetries: 0, maxPatchRounds: 0, patchAllowed: false, humanOnly: false },
  AUTH: { maxRetries: 1, maxPatchRounds: 0, patchAllowed: false, humanOnly: true },
  CAPTCHA: { maxRetries: 1, maxPatchRounds: 0, patchAllowed: false, humanOnly: true },
  SIDE_EFFECT: { maxRetries: 0, maxPatchRounds: 0, patchAllowed: false, humanOnly: true },
  STRUCTURAL: { maxRetries: 0, maxPatchRounds: 2, patchAllowed: true, humanOnly: false },
  PROVIDER: { maxRetries: 2, maxPatchRounds: 0, patchAllowed: false, humanOnly: false },
  UNKNOWN: { maxRetries: 1, maxPatchRounds: 1, patchAllowed: true, humanOnly: false },
}

/** The budget for a category. */
export function budgetForCategory(category: WorkflowFailureCategory): CategoryBudget {
  return CATEGORY_BUDGET[category]
}

/** The budget implied by a classified failure. */
export function budgetForAnalysis(analysis: FailureAnalysisV2): CategoryBudget {
  return budgetForCategory(analysis.category)
}

export type BudgetDecision =
  | 'RETRY'
  | 'PATCH'
  | 'STOP_NO_IMPROVEMENT'
  | 'STOP_BUDGET_EXHAUSTED'
  | 'STOP_FORBIDDEN'
  | 'REQUEST_HUMAN'

/** Outcome of a failed repair round the tracker observes. */
export interface RepairRoundOutcome {
  /** True when the latest replay recovered (verified). */
  recovered: boolean
  /**
   * Signature of the remaining failure. Identical signatures across rounds
   * mean "no improvement" (e.g. same failed node + failure code + message).
   */
  failureSignature: string
}

export interface BudgetTrackerState {
  category: WorkflowFailureCategory
  retriesUsed: number
  patchRoundsUsed: number
  /** Failure signatures seen across rounds, in order. */
  signatures: string[]
  /** Number of consecutive rounds with an identical signature. */
  stagnantRounds: number
  exhausted: boolean
}

/** Rounds with no change after which we stop early. */
export const NO_IMPROVEMENT_LIMIT = 2

/** Start tracking recovery for a classified failure. */
export function startBudget(category: WorkflowFailureCategory): BudgetTrackerState {
  return {
    category,
    retriesUsed: 0,
    patchRoundsUsed: 0,
    signatures: [],
    stagnantRounds: 0,
    exhausted: false,
  }
}

function stopState(
  state: BudgetTrackerState,
  decision: Extract<BudgetDecision, `STOP_${string}`> | 'REQUEST_HUMAN',
): { decision: typeof decision; state: BudgetTrackerState } {
  return { decision, state: { ...state, exhausted: decision !== 'REQUEST_HUMAN' } }
}

/**
 * Decide the next recovery action given the tracker and the outcome of the
 * last round. Call this after a retry or patch attempt failed; when the
 * attempt recovered, no decision is needed.
 *
 * Pure: returns the next decision and the updated tracker state.
 */
export function decideNextBudget(
  prev: BudgetTrackerState,
  outcome: RepairRoundOutcome,
): { decision: BudgetDecision; state: BudgetTrackerState } {
  if (outcome.recovered) {
    return { decision: 'RETRY', state: prev }
  }

  const budget = budgetForCategory(prev.category)

  if (budget.humanOnly) {
    return stopState(prev, 'REQUEST_HUMAN')
  }

  // Track improvement. No-improvement is meaningful only between consecutive
  // PATCH rounds: a retry failing and then a patch producing the same failure
  // is not evidence the patch is worthless (the patch has not run twice yet).
  const lastSignature = prev.signatures.at(-1)
  const comparingPatchRounds = prev.patchRoundsUsed > 0
  const stagnant =
    comparingPatchRounds &&
    typeof lastSignature === 'string' &&
    lastSignature === outcome.failureSignature
      ? prev.stagnantRounds + 1
      : 0
  const signatures = [...prev.signatures, outcome.failureSignature]
  let state: BudgetTrackerState = { ...prev, signatures, stagnantRounds: stagnant }

  // Early stop: two consecutive patch rounds with no change.
  if (stagnant >= NO_IMPROVEMENT_LIMIT) {
    return stopState(state, 'STOP_NO_IMPROVEMENT')
  }

  // Prefer retries while the budget allows and they are meaningful.
  if (state.retriesUsed < budget.maxRetries) {
    state = { ...state, retriesUsed: state.retriesUsed + 1 }
    return { decision: 'RETRY', state }
  }

  // Retries exhausted: forbid or bound the patch.
  if (!budget.patchAllowed || budget.maxPatchRounds === 0) {
    return stopState(state, 'STOP_FORBIDDEN')
  }
  if (state.patchRoundsUsed >= budget.maxPatchRounds) {
    return stopState(state, 'STOP_BUDGET_EXHAUSTED')
  }
  state = { ...state, patchRoundsUsed: state.patchRoundsUsed + 1 }
  return { decision: 'PATCH', state }
}

/**
 * Whether an AI patch is permissible at all for a category BEFORE any work,
 * independent of tracker progress. Used by the orchestrator to refuse a patch
 * up front (e.g. side-effect-unknown).
 */
export function patchIsAllowed(category: WorkflowFailureCategory): boolean {
  const budget = budgetForCategory(category)
  return budget.patchAllowed && budget.maxPatchRounds > 0 && !budget.humanOnly
}

/** Build a stable signature for a remaining failure. */
export function failureSignatureOf(input: {
  failedNodeId?: string
  code?: string
  message?: string
}): string {
  return [input.failedNodeId ?? '', input.code ?? '', (input.message ?? '').trim().slice(0, 120)].join('|')
}
