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
  /**
   * Which layers actually had something to check. `layers.*: true` with
   * `evaluated.*: false` means "nothing contradicted us", not "we proved it".
   */
  evaluated: { postconditions: boolean; goal: boolean }
  /** Human/audit description of the unmet conditions. */
  unmet: string[]
  /** Conditions the verification actually evaluated. */
  evaluatedConditions: WorkflowCondition[]
  note?: string
}

// --- Condition aggregation ---------------------------------------------------

/**
 * Can this condition, read true on the live page, prove that the FAILED step's
 * effect landed?
 *
 * A URL says where the run IS, not what it DID: the publish page keeps
 * `/publish/` in its address whether or not the title ever committed, so a goal
 * whose success row is `urlContains /publish/` holds before the workflow starts.
 * Answering S0 with that closes the entire ladder on the first attempt — every
 * strategy "passes" without changing anything, which is the repair equivalent of
 * reading the absence of evidence as success. `terminalStateConditions` are
 * exempt because reaching a DIFFERENT address is exactly the documented proof
 * that an action already landed elsewhere; this predicate is applied to the
 * success row only, at the S0 call site.
 */
export function provesLandedEffect(condition: WorkflowCondition): boolean {
  return (
    condition.kind !== 'urlContains' &&
    condition.kind !== 'urlMatches' &&
    !isVacuousPresenceRow(condition)
  )
}

/**
 * A presence row pointed at the document root — `elementExists` on `body`, which
 * is what a model writes when it has no locator to name.
 *
 * Making a `{selector}` target observable (round 26's fix) is what opened this:
 * such a row now resolves, and resolves ALWAYS. Left as evidence it certifies a
 * goal nothing wrote, and it short-circuits the repair ladder into reporting
 * `terminal state already holds` in 14 ms for a step that failed on a hidden
 * upload control (round 31). An absence would prove something; this cannot.
 */
const ROOT_SELECTOR = /^(?:body|html|\*|:root)$/i

export function isVacuousPresenceRow(condition: WorkflowCondition): boolean {
  if (
    condition.kind !== 'elementExists' &&
    condition.kind !== 'elementVisible' &&
    condition.kind !== 'elementEnabled'
  ) {
    return false
  }
  const selector = (condition.target as { selector?: unknown }).selector
  return typeof selector === 'string' && ROOT_SELECTOR.test(selector.trim())
}

/**
 * Does this URL row hold because the workflow itself puts the browser there?
 *
 * A terminal-state row is supposed to name the address the page reaches ONLY
 * AFTER the action landed. In practice generation files the address it was
 * already sitting on there (the round-17 draft graph: `urlContains
 * creator.xiaohongshu.com`, while its own first node opens that page), and then
 * S0 reports "terminal state already holds" for a step that failed, the repair
 * commits nothing, and the run is called a success. Any URL the graph names in
 * its own params — an open-url, a recorded origin — is satisfied by construction
 * and can carry no evidence about this step.
 */
export function urlHoldsByConstruction(workflow: Workflow, condition: WorkflowCondition): boolean {
  if (condition.kind !== 'urlContains' && condition.kind !== 'urlMatches') return false
  const needle = condition.value.trim().toLowerCase()
  if (!needle) return false
  const haystacks: string[] = []
  for (const node of workflow.drawflow?.nodes ?? []) {
    for (const value of Object.values((node.data ?? {}) as Record<string, unknown>)) {
      if (typeof value === 'string') haystacks.push(value)
    }
  }
  const settings = workflow.settings as unknown as Record<string, unknown> | undefined
  if (typeof settings?.['generationOriginUrl'] === 'string') {
    haystacks.push(settings['generationOriginUrl'] as string)
  }
  const context = settings?.['pageContext'] as
    { origin?: string; additionalOrigins?: string[] } | undefined
  if (typeof context?.origin === 'string') haystacks.push(context.origin)
  haystacks.push(...(context?.additionalOrigins ?? []))
  return haystacks.some((text) => text.toLowerCase().includes(needle))
}

/**
 * Can this terminal-state row carry the layer, for THIS workflow?
 *
 * Terminal rows keep the URL exemption {@link provesLandedEffect} denies a
 * success row — reaching a DIFFERENT address is exactly the documented trace an
 * action leaves behind. What they do not keep is an address the graph visits by
 * design, nor a presence row pointed at the document root: `body` is there
 * whether the step ran or not, and that is the row round 31's S0 read as
 * "terminal state already holds" over a failed upload step.
 */
export function provesTerminalEffect(workflow: Workflow, condition: WorkflowCondition): boolean {
  return !urlHoldsByConstruction(workflow, condition) && !isVacuousPresenceRow(condition)
}

/**
 * Aggregate a layer's conditions.
 *
 * `satisfied` answers "did anything contradict the claim"; `observed` answers
 * "was anything checked at all". An empty list is vacuously satisfied, and a
 * caller that reads that as VERIFIED is reporting the absence of evidence as
 * success — which is how a repair that did nothing claims the goal was met.
 * Every short-circuit therefore has to demand `observed` as well.
 */
async function evaluateAll(
  deps: VerificationDeps,
  conditions: WorkflowCondition[],
): Promise<{
  satisfied: boolean
  observed: boolean
  unmet: string[]
  evaluated: WorkflowCondition[]
}> {
  if (conditions.length === 0) {
    return { satisfied: true, observed: false, unmet: [], evaluated: [] }
  }
  const outcomes = await deps.evaluateConditions(conditions)
  const unmet = outcomes
    .filter((outcome) => !outcome.satisfied)
    .map((outcome) => outcome.note ?? describeCondition(outcome.condition))
  return {
    satisfied: unmet.length === 0,
    observed: outcomes.length > 0,
    unmet,
    evaluated: conditions,
  }
}

/**
 * S0 — check whether the goal / terminal state already holds WITHOUT
 * running anything. Used before a candidate is applied to avoid re-driving
 * an unsafe action whose effect already landed.
 */
export async function checkGoalAlreadySatisfied(
  workflow: Workflow,
  deps: VerificationDeps,
): Promise<{
  satisfied: boolean
  evaluated: WorkflowCondition[]
  note?: string
}> {
  const goal = goalSpecOf(workflow)
  if (!goal) return { satisfied: false, evaluated: [] }
  // Only conditions that can prove the FAILED STEP's effect landed. A URL
  // condition holds before the step, while it and after it — the publish page is
  // still `/publish/publish` when the title never committed — so accepting one
  // here lets the whole ladder short-circuit on the first attempt and report a
  // repair that changed nothing. Terminal-state conditions keep their own
  // meaning below (a URL the page reaches ONLY after the action).
  const evidence = goal.successConditions.filter(provesLandedEffect)
  const success = await evaluateAll(deps, evidence)
  if (success.satisfied && success.observed) {
    return {
      satisfied: true,
      evaluated: [...evidence],
      note: 'goal success conditions already hold',
    }
  }
  // Variable-only conditions can be checked even without a live page; when
  // all success conditions are variable-only and failed, the goal is not met.
  // Terminal rows keep their URL exemption above, but only for URLs the graph
  // does not open itself — one it navigates to proves nothing about this step.
  const terminalEvidence = (goal.terminalStateConditions ?? []).filter((condition) =>
    provesTerminalEffect(workflow, condition),
  )
  if (terminalEvidence.length) {
    const terminal = await evaluateAll(deps, terminalEvidence)
    if (terminal.satisfied && terminal.observed) {
      return {
        satisfied: true,
        evaluated: [...terminalEvidence],
        note: 'terminal state already holds',
      }
    }
  }
  return { satisfied: false, evaluated: [...success.evaluated] }
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
  const checked: WorkflowCondition[] = []

  // L2: candidate expected postconditions.
  const post = await evaluateAll(deps, candidate.expectedPostconditions)
  unmet.push(...post.unmet)
  checked.push(...post.evaluated)
  const postconditionsHeld = post.satisfied

  // L3: workflow goal.
  const goal = goalSpecOf(workflow)
  let goalHeld = false
  let goalEvaluated = false
  if (goal) {
    const success = await evaluateAll(deps, goal.successConditions)
    unmet.push(...success.unmet)
    checked.push(...success.evaluated)
    goalEvaluated = success.observed
    if (success.satisfied && success.observed) {
      goalHeld = true
    } else {
      // Terminal-state conditions: the action already landed earlier — but a
      // URL the graph navigates to itself holds before any step ran, so it
      // cannot carry this layer either.
      const terminalEvidence = (goal.terminalStateConditions ?? []).filter((condition) =>
        provesTerminalEffect(workflow, condition),
      )
      if (terminalEvidence.length) {
        const terminal = await evaluateAll(deps, terminalEvidence)
        unmet.push(...terminal.unmet)
        checked.push(...terminal.evaluated)
        goalEvaluated = terminal.observed
        goalHeld = terminal.satisfied && terminal.observed
      }
    }
  } else {
    // A workflow with no goal spec is L3-valid once L1+L2 hold (compat /
    // simple read flows). It is reported as NOT evaluated so no caller reads
    // this branch as "the goal was verified".
    goalHeld = true
  }

  const passed = nodeSucceeded && postconditionsHeld && goalHeld
  return {
    passed,
    alreadySatisfied: false,
    layers: { node: nodeSucceeded, postconditions: postconditionsHeld, goal: goalHeld },
    evaluated: { postconditions: post.observed, goal: goalEvaluated },
    unmet,
    evaluatedConditions: checked,
    ...(passed
      ? {
          note:
            goalEvaluated || post.observed
              ? 'all verification layers passed'
              : 'candidate accepted on the node result alone (no goal contract to verify)',
        }
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
      // Nothing was replayed: only the goal observation below is evidence.
      evaluated: { postconditions: false, goal: true },
      unmet: [],
      evaluatedConditions: already.evaluated,
      note: already.note,
    }
  }
  return verifyRepairCandidate({ workflow, candidate, nodeSucceeded, deps })
}

/** Whether all conditions in a list are checkable without a live page. */
export function allVariableOnly(conditions: WorkflowCondition[]): boolean {
  return conditions.length > 0 && conditions.every(isVariableOnlyCondition)
}
