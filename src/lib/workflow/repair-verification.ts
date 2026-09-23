/**
 * Repair verification (spec §24, Commit 10).
 *
 * The three-layer verification a candidate must pass:
 *
 * ```text
 * L1 node           the changed node operation executed successfully
 * L2 postconditions the node / candidate postconditions held
 * L3 goal           the workflow goalSpec is satisfied
 * ```
 *
 * Only an L3 pass may be reported as `AUTO_REPAIRED`. A candidate that
 * passes L1/L2 but leaves the goal unsatisfied fails and the orchestrator
 * moves to the next strategy. Before any dangerous re-execution the
 * terminal-state / goal check runs FIRST: when the goal is already
 * satisfied (e.g. the order was actually submitted) verification
 * short-circuits without replaying the unsafe action (spec §24, §15 S0).
 *
 * Verification primitives (a runner and a condition/goal evaluator) are
 * injected so this module stays free of `chrome` / DOM.
 *
 * @module lib/workflow/repair-verification
 */
import { describeCondition, isVariableOnlyCondition, type WorkflowCondition } from './conditions'
import { goalSpecOf } from './reliability'
import type { Workflow } from './types'
import type { RepairCandidate } from './repair-candidate'

// --- Verification primitives --------------------------------------------------

export interface VerificationDeps {
  /**
   * Evaluate conditions against the current live page + variables. Returns
   * each condition with its verdict (index aligned with input).
   */
  evaluateConditions: (
    conditions: WorkflowCondition[],
  ) => Promise<Array<{ condition: WorkflowCondition; satisfied: boolean; note?: string }>>
}

// --- Layer results ------------------------------------------------------------

export interface VerificationLayerResult {
  /** L1: the node operation returned success. */
  node: boolean
  /** L2: the candidate + node postconditions held. */
  postconditions: boolean
  /** L3: the goal spec is satisfied. */
  goal: boolean
}

export interface RepairVerificationResult {
  passed: boolean
  /** Whether the goal was already satisfied (no dangerous replay happened). */
  alreadySatisfied: boolean
  layers: VerificationLayerResult
  /** Human/audit description of the unmet conditions. */
  unmet: string[]
  /** Conditions the verification actually evaluated. */
  evaluatedConditions: WorkflowCondition[]
  note?: string
}

// --- Condition aggregation ---------------------------------------------------

async function evaluateAll(
  deps: VerificationDeps,
  conditions: WorkflowCondition[],
): Promise<{ satisfied: boolean; unmet: string[]; evaluated: WorkflowCondition[] }> {
  if (conditions.length === 0) {
    return { satisfied: true, unmet: [], evaluated: [] }
  }
  const outcomes = await deps.evaluateConditions(conditions)
  const unmet = outcomes
    .filter((outcome) => !outcome.satisfied)
    .map((outcome) => outcome.note ?? describeCondition(outcome.condition))
  return { satisfied: unmet.length === 0, unmet, evaluated: conditions }
}

/**
 * S0 — check whether the goal / terminal state already holds WITHOUT
 * running anything. Used before a candidate is applied to avoid re-driving
 * an unsafe action whose effect already landed.
 */
export async function checkGoalAlreadySatisfied(
  workflow: Workflow,
  deps: VerificationDeps,
): Promise<{ satisfied: boolean; note?: string }> {
  const goal = goalSpecOf(workflow)
  if (!goal) return { satisfied: false }
  const success = await evaluateAll(deps, goal.successConditions)
  if (success.satisfied) {
    return { satisfied: true, note: 'goal success conditions already hold' }
  }
  // Variable-only conditions can be checked even without a live page; when
  // all success conditions are variable-only and failed, the goal is not met.
  if (goal.terminalStateConditions?.length) {
    const terminal = await evaluateAll(deps, goal.terminalStateConditions)
    if (terminal.satisfied) {
      return { satisfied: true, note: 'terminal state already holds' }
    }
  }
  return { satisfied: false }
}

export interface VerifyCandidateInput {
  workflow: Workflow
  candidate: RepairCandidate
  /** L1 verdict from the executor (the node operation succeeded). */
  nodeSucceeded: boolean
  deps: VerificationDeps
}

/**
 * Run L2 + L3 over an applied candidate. L1 is supplied by the caller (the
 * executor result). Only when all three hold does the result pass.
 */
export async function verifyRepairCandidate(
  input: VerifyCandidateInput,
): Promise<RepairVerificationResult> {
  const { workflow, candidate, nodeSucceeded, deps } = input
  const unmet: string[] = []
  const evaluated: WorkflowCondition[] = []

  // L2: candidate expected postconditions.
  const post = await evaluateAll(deps, candidate.expectedPostconditions)
  unmet.push(...post.unmet)
  evaluated.push(...post.evaluated)
  const postconditionsHeld = post.satisfied

  // L3: workflow goal.
  const goal = goalSpecOf(workflow)
  let goalHeld = false
  if (goal) {
    const success = await evaluateAll(deps, goal.successConditions)
    unmet.push(...success.unmet)
    evaluated.push(...success.evaluated)
    if (success.satisfied) {
      goalHeld = true
    } else if (goal.terminalStateConditions?.length) {
      // Terminal-state conditions: the action already landed earlier.
      const terminal = await evaluateAll(deps, goal.terminalStateConditions)
      unmet.push(...terminal.unmet)
      evaluated.push(...terminal.evaluated)
      goalHeld = terminal.satisfied
    }
  } else {
    // A workflow with no goal spec is L3-valid once L1+L2 hold (compat /
    // simple read flows).
    goalHeld = true
  }

  const passed = nodeSucceeded && postconditionsHeld && goalHeld
  return {
    passed,
    alreadySatisfied: false,
    layers: { node: nodeSucceeded, postconditions: postconditionsHeld, goal: goalHeld },
    unmet,
    evaluatedConditions: evaluated,
    ...(passed
      ? { note: 'all verification layers passed' }
      : { note: unmet[0] ?? 'verification failed' }),
  }
}

/**
 * Full repair verification entry: S0 goal-first short-circuit, then the
 * candidate layers. When the goal already holds the result passes without
 * the caller needing to re-execute dangerous actions.
 */
export async function verifyRepair(
  workflow: Workflow,
  candidate: RepairCandidate,
  nodeSucceeded: boolean,
  deps: VerificationDeps,
): Promise<RepairVerificationResult> {
  const already = await checkGoalAlreadySatisfied(workflow, deps)
  if (already.satisfied) {
    return {
      passed: true,
      alreadySatisfied: true,
      layers: { node: true, postconditions: true, goal: true },
      unmet: [],
      evaluatedConditions: [],
      note: already.note,
    }
  }
  return verifyRepairCandidate({ workflow, candidate, nodeSucceeded, deps })
}

/** Whether all conditions in a list are checkable without a live page. */
export function allVariableOnly(conditions: WorkflowCondition[]): boolean {
  return conditions.length > 0 && conditions.every(isVariableOnlyCondition)
}
