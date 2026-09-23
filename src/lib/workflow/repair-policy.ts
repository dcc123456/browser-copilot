/**
 * Repair policy — the strategy ladder (spec §15, §22, §25, Commit 7).
 *
 * Pure functions deciding WHICH strategy the repair orchestrator tries next
 * instead of letting the LLM choose freely every time:
 *
 * ```text
 * S0 terminal-state-check   goal already satisfied?
 * S1 readiness-recovery     wait / scroll / focus / re-observe / retry
 * S2 locator-repair         verified selector → testid → aria → role+name …
 * S3 parameter-repair       input value / timeout / options / key sequence
 * S4 local-graph-repair     insert / delete / replace within failed node ±2
 * S5 section-replan         regenerate the failed section
 * S6 full-workflow-replan   whole graph rewrite (rewriteRisk retained)
 * S7 agent-rescue           live agent loop as the last automatic strategy
 * ```
 *
 * The ladder is walked in order, skipping strategies already proven
 * dead-ended against the same evidence. Budget bounds the walk.
 *
 * Pure module: no `chrome`, no DOM.
 *
 * @module lib/workflow/repair-policy
 */
import type { WorkflowFailureType } from './failure-classification'
import { failureTypePolicy } from './failure-classification'
import type { RepairAttempt, RepairBudget, RepairStrategy } from './repair-session'
import { REPAIR_STRATEGIES } from './repair-session'

// --- Ladder order -------------------------------------------------------------

/**
 * The default ladder, in attempt order. S0 always runs first (it costs
 * nothing and prevents re-executing a dangerous action that already landed).
 */
export const REPAIR_LADDER: readonly RepairStrategy[] = REPAIR_STRATEGIES

/** Strategies that need a model call (vs purely deterministic actions). */
export const MODEL_STRATEGIES: ReadonlySet<RepairStrategy> = new Set<RepairStrategy>([
  'locator-repair',
  'parameter-repair',
  'local-graph-repair',
  'section-replan',
  'full-workflow-replan',
  'agent-rescue',
])

/** Whether a strategy consumes the model-call budget. */
export function strategyUsesModel(strategy: RepairStrategy): boolean {
  return MODEL_STRATEGIES.has(strategy)
}

// --- Failure → preferred strategy mapping ------------------------------------

/**
 * The first strategy to try for a given failure type, after S0. Most
 * ordinary failures map to exactly one deterministic or model strategy.
 */
const PREFERRED_FIRST: Partial<Record<WorkflowFailureType, RepairStrategy>> = {
  PAGE_NOT_READY: 'readiness-recovery',
  NAVIGATION_TIMEOUT: 'readiness-recovery',
  ELEMENT_NOT_VISIBLE: 'readiness-recovery',
  ELEMENT_NOT_INTERACTABLE: 'readiness-recovery',
  SELECTOR_STALE: 'locator-repair',
  ELEMENT_NOT_FOUND: 'locator-repair',
  ELEMENT_AMBIGUOUS: 'locator-repair',
  INPUT_REJECTED: 'parameter-repair',
  INVALID_PARAMETER: 'parameter-repair',
  STATE_MISMATCH: 'local-graph-repair',
  POSTCONDITION_FAILED: 'parameter-repair',
  GOAL_NOT_SATISFIED: 'section-replan',
  WORKFLOW_GRAPH_INVALID: 'local-graph-repair',
  MODEL_NO_CANDIDATE: 'readiness-recovery',
  MODEL_OUTPUT_INVALID: 'readiness-recovery',
  MODEL_ERROR: 'readiness-recovery',
}

/**
 * The ordered ladder starting from the failure's preferred strategy.
 * S0 is always prepended. Strategies after the preferred one are the
 * escalation path.
 */
export function ladderForFailure(type: WorkflowFailureType): RepairStrategy[] {
  const preferred = PREFERRED_FIRST[type] ?? 'readiness-recovery'
  const preferredIndex = REPAIR_LADDER.indexOf(preferred)
  const tail = REPAIR_LADDER.slice(preferredIndex === -1 ? 1 : preferredIndex)
  return ['terminal-state-check', ...tail]
}

// --- nextStrategyOf (the core pure policy) -----------------------------------

export interface PolicyInput {
  /** The classified failure type. */
  failureType: WorkflowFailureType
  /** Attempts already made (strategy + outcome + diagnosis + verification). */
  attempts: readonly RepairAttempt[]
  budget: RepairBudget
  /** Model calls already spent. */
  modelCalls: number
  /** When the repair started (duration budget). */
  startedAt: number
  now?: number
}

export type NextStrategyResult =
  | { kind: 'next'; strategy: RepairStrategy }
  | { kind: 'exhausted'; reason: string }
  | { kind: 'blocked'; reason: string }

/** Outcomes that prove a strategy produced no usable candidate. */
const DEAD_END_OUTCOMES: ReadonlySet<RepairAttempt['outcome']> = new Set<RepairAttempt['outcome']>([
  'no-candidate',
  'invalid-candidate',
  'apply-failed',
  'verification-failed',
])

function sameSignature(a: RepairAttempt, b: RepairAttempt): boolean {
  if (a.strategy !== b.strategy) return false
  const aType = a.diagnosis?.type
  const bType = b.diagnosis?.type
  if (aType !== bType) return false
  const aNote = a.verification?.layers.note ?? ''
  const bNote = b.verification?.layers.note ?? ''
  return aNote === bNote
}

/**
 * Decide the next strategy (spec §15 ladder, §22 budget).
 *
 * Rules:
 *   1. external human gates (AUTH/CAPTCHA/MFA) and side-effect-unknown are a
 *      safety BLOCK, not a ladder walk;
 *   2. never repeat a strategy that already dead-ended against the same
 *      evidence (beyond `maxSameFailureSignature`);
 *   3. never exceed maxAttempts / maxModelCalls / maxTotalDurationMs;
 *   4. return the first ladder strategy that remains; otherwise `exhausted`.
 */
export function nextStrategyOf(input: PolicyInput): NextStrategyResult {
  const { failureType, attempts, budget } = input
  const now = input.now ?? Date.now()
  const policy = failureTypePolicy(failureType)

  // 1. Safety / external gates block immediately. These are the sanctioned
  //    HUMAN_TAKEOVER cases (spec §21.1) — not an ordinary repair failure.
  if (policy.humanGate) {
    return { kind: 'blocked', reason: `external gate: ${failureType}` }
  }
  if (failureType === 'SIDE_EFFECT_UNKNOWN') {
    return {
      kind: 'blocked',
      reason: 'unsafe side effect already fired with an unknown result; blind replay refused',
    }
  }

  // Duration budget.
  if (now - input.startedAt >= budget.maxTotalDurationMs) {
    return { kind: 'exhausted', reason: 'total duration budget exceeded' }
  }
  // Attempt budget.
  if (attempts.length >= budget.maxAttempts) {
    return { kind: 'exhausted', reason: 'attempt budget exhausted' }
  }

  // Build the candidate ladder.
  const ladder = ladderForFailure(failureType)
  const attempted = attempts

  for (const strategy of ladder) {
    const sameStrategy = attempted.filter((attempt) => attempt.strategy === strategy)
    if (sameStrategy.length > budget.maxStrategyRepeats + 1) continue

    // A strategy already dead-ended with the same evidence is skipped.
    const deadEnds = sameStrategy.filter((attempt) => DEAD_END_OUTCOMES.has(attempt.outcome))
    const duplicates = deadEnds.filter((deadEnd) =>
      deadEnds.some((other) => other !== deadEnd && sameSignature(deadEnd, other)),
    )
    if (duplicates.length >= budget.maxSameFailureSignature) continue
    // Any prior dead-end at all with this strategy means move on unless the
    // repeat allowance still holds (maxStrategyRepeats+1 covers one retry).
    if (deadEnds.length > 0 && sameStrategy.length > budget.maxStrategyRepeats + 1) continue

    // Model-call budget.
    if (strategyUsesModel(strategy)) {
      if (input.modelCalls >= budget.maxModelCalls) continue
    }
    return { kind: 'next', strategy }
  }

  return { kind: 'exhausted', reason: 'all repair strategies exhausted' }
}

// --- Local graph scope (spec §15 Strategy 4) ---------------------------------

/**
 * The node window a local graph repair may touch: the failed node plus up to
 * `radius` nodes on either side, in graph order. Keeps a small problem from
 * rewriting the whole graph.
 */
export function localRepairWindow(
  orderedNodeIds: readonly string[],
  failedNodeId: string,
  radius = 2,
): Set<string> {
  const index = orderedNodeIds.indexOf(failedNodeId)
  if (index === -1) return new Set([failedNodeId])
  const from = Math.max(0, index - radius)
  const to = Math.min(orderedNodeIds.length, index + radius + 1)
  return new Set(orderedNodeIds.slice(from, to))
}

/** Whether a strategy is an escalation strictly after S1 readiness. */
export function isEscalation(strategy: RepairStrategy): boolean {
  return REPAIR_LADDER.indexOf(strategy) > 1
}
