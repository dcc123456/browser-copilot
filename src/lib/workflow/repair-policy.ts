/**
 * Repair policy — the strategy ladder (spec §15, §22, §25, Commit 7).
 *
 * Pure functions deciding WHICH strategy the repair orchestrator tries next
 * instead of letting the LLM choose freely every time:
 *
 * ```text
 * S0 terminal-state-check   goal already satisfied?
 * S1 readiness-recovery     wait / scroll / focus / re-observe / retry
 * S1.5 page-context-reanchor  move the recorded grounding to the site the
 *                            graph's own first navigation drives onto
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
  PAGE_CONTEXT_MISMATCH: 'page-context-reanchor',
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
/**
 * Whether ONE named strategy is currently legal and affordable to attempt.
 *
 * Split out of {@link nextStrategyOf} so a reflection can propose a strategy
 * and be held to exactly the same gate: safety blocks and budget limits first,
 * then the per-strategy dead-end and repeat rules. A reflection therefore
 * reroutes the ladder but can never talk it past a rule.
 */
export function strategyAdmissible(
  strategy: RepairStrategy,
  input: PolicyInput,
): NextStrategyResult | undefined {
  const { failureType, attempts, budget } = input
  const policy = failureTypePolicy(failureType)

  if (policy.humanGate) return { kind: 'blocked', reason: `external gate: ${failureType}` }
  if (failureType === 'SIDE_EFFECT_UNKNOWN') {
    return {
      kind: 'blocked',
      reason: 'unsafe side effect already fired with an unknown result; blind replay refused',
    }
  }
  if ((input.now ?? Date.now()) - input.startedAt >= budget.maxTotalDurationMs) {
    return { kind: 'exhausted', reason: 'total duration budget exceeded' }
  }
  if (attempts.length >= budget.maxAttempts) {
    return { kind: 'exhausted', reason: 'attempt budget exhausted' }
  }
  // Only a rung of this failure's own ladder is ever a candidate.
  if (!(ladderForFailure(failureType) as readonly string[]).includes(strategy)) return undefined

  const sameStrategy = attempts.filter((attempt) => attempt.strategy === strategy)
  if (sameStrategy.length > budget.maxStrategyRepeats + 1) return undefined

  const deadEnds = sameStrategy.filter((attempt) => DEAD_END_OUTCOMES.has(attempt.outcome))
  const duplicates = deadEnds.filter((deadEnd) =>
    deadEnds.some((other) => other !== deadEnd && sameSignature(deadEnd, other)),
  )
  if (duplicates.length >= budget.maxSameFailureSignature) return undefined
  if (deadEnds.length > 0 && sameStrategy.length > budget.maxStrategyRepeats + 1) return undefined

  if (strategyUsesModel(strategy) && input.modelCalls >= budget.maxModelCalls) return undefined

  return { kind: 'next', strategy }
}

export function nextStrategyOf(input: PolicyInput): NextStrategyResult {
  const { failureType } = input

  // Safety gates and the global budgets reject EVERY strategy at once, so they
  // are answered before the walk rather than per-rung.
  const gate = strategyAdmissible(ladderForFailure(failureType)[0]!, input)
  if (gate && gate.kind !== 'next') return gate

  for (const strategy of ladderForFailure(failureType)) {
    const verdict = strategyAdmissible(strategy, input)
    if (verdict?.kind === 'next') return verdict
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
