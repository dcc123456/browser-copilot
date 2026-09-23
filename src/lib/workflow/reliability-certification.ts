/**
 * Reliability certification — layered metrics + the certification state
 * machine (spec §15/§16 Phase 11).
 *
 * Layered metrics, each answering a different question:
 *   L1 executionSuccess   — did the steps run? (engine-level pass rate)
 *   L2 verificationSuccess— of those, how many carry VERIFIED evidence
 *                           (postconditions held, side effects fired exactly
 *                           once — not "the engine returned ok")?
 *   L3 goalAchieved       — did the BUSINESS goal land? (goal conditions /
 *                           the scenario's encoded target)
 *
 * The certification state machine gates what may be CLAIMED about a workflow:
 *   Draft → Validated (static contract validation passed)
 *         → Verified  (a benchmark run met its L1/L2 targets)
 *         → Certified (L3 goals achieved on the certified scenario set)
 *   any → Stale (the graph changed, or a rerun regressed)
 * A claim may only cite the state it reached — "ran" is not "verified" is not
 * "achieved the goal".
 *
 * @module lib/workflow/reliability-certification
 */

export const CERTIFICATION_STATES = ['Draft', 'Validated', 'Verified', 'Certified', 'Stale'] as const
export type CertificationState = (typeof CERTIFICATION_STATES)[number]

export type CertificationEvent =
  | 'validate-ok'
  | 'validate-failed'
  | 'benchmark-passed'
  | 'benchmark-failed'
  | 'certify'
  | 'graph-changed'
  | 'regression'

/** One scenario's benchmark measurement. */
export interface ScenarioBenchmark {
  scenarioId: string
  /** L1 — the engine completed the run. */
  executionSuccess: boolean
  /** L2 — success carries verified evidence (side effects clean). */
  verificationSuccess: boolean
  /** L3 — the business goal the scenario encodes landed. */
  goalAchieved: boolean
  /** Side-effect evidence: how many times the terminal action fired. */
  submitCalls?: number
}

export interface BenchmarkMetrics {
  /** Share of scenarios that ran to completion. */
  l1ExecutionSuccess: number
  /** Share of L1 successes with verified evidence. */
  l2VerificationSuccess: number
  /** Share of scenarios whose business goal landed. */
  l3GoalAchieved: number
  total: number
  failures: string[]
}

/** Compute the layered metrics from per-scenario measurements. */
export function computeBenchmarkMetrics(scenarios: ScenarioBenchmark[]): BenchmarkMetrics {
  const total = scenarios.length
  const failures: string[] = []
  const l1 = scenarios.filter((s) => s.executionSuccess)
  for (const s of scenarios) {
    if (!s.executionSuccess) failures.push(`${s.scenarioId}: L1 未通过`)
    else if (!s.verificationSuccess) failures.push(`${s.scenarioId}: L2 缺少验证证据`)
    else if (!s.goalAchieved) failures.push(`${s.scenarioId}: L3 目标未达成`)
  }
  // L2/L3 are conditional on the previous layer: a run that did not execute
  // cannot "verify", and an unverified run cannot claim the goal.
  const l2 = l1.filter((s) => s.verificationSuccess)
  const l3 = l2.filter((s) => s.goalAchieved)
  return {
    l1ExecutionSuccess: total ? l1.length / total : 0,
    l2VerificationSuccess: total ? l2.length / total : 0,
    l3GoalAchieved: total ? l3.length / total : 0,
    total,
    failures,
  }
}

/**
 * The certification state machine. Pure function of (state, event) → state —
 * the benchmark runner and the panel consume the same transitions.
 */
export function transitionCertification(
  state: CertificationState,
  event: CertificationEvent,
): CertificationState {
  switch (event) {
    case 'validate-ok':
      return state === 'Draft' || state === 'Stale' ? 'Validated' : state
    case 'benchmark-passed':
      return state === 'Validated' || state === 'Stale' ? 'Verified' : state
    case 'certify':
      return state === 'Verified' ? 'Certified' : state
    case 'validate-failed':
    case 'benchmark-failed':
    case 'graph-changed':
    case 'regression':
      return state === 'Draft' ? 'Draft' : 'Stale'
    default:
      return state
  }
}

/** Fold a sequence of events (the benchmark's run log) into a final state. */
export function certifyThrough(events: CertificationEvent[]): CertificationState {
  return events.reduce<CertificationState>((state, event) => transitionCertification(state, event), 'Draft')
}
