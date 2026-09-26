/**
 * Structured operator failure reports and the recovery state machine.
 *
 * Every operator failure becomes an {@link OperatorFailureReport} with a phase,
 * error code, target-state detail, retryability and suggested recovery — not a
 * raw string. When the top candidates all fail, the recovery state machine
 * (spec §12) decides the next move based on the classified phases: re-ground
 * and retry the same operator, or expand the search and return the next
 * candidates. It never blindly picks a 4th tool, never defaults to JS, and
 * never declares failure without analysis.
 *
 * Pure module — no `chrome`, no DOM.
 *
 * @module lib/workflow/recovery
 */

import {
  findWorkflowOperators,
  type DiscoveryInput,
  type DiscoveryResult,
} from './operator-discovery'
import type { PageStructureSignals } from './semantic-intent'
import type { WorkflowCondition } from './conditions'

/** The phase in which an operator failed. */
export type OperatorFailurePhase =
  | 'target-resolution'
  | 'precondition'
  | 'parameter'
  | 'execution'
  | 'postcondition'
  | 'unsupported'
  | 'unknown'

/** A concrete recovery action. */
export interface RecoveryAction {
  kind:
    | 'reground'
    | 'retry-same'
    | 'expand-search'
    | 'adjust-parameter'
    | 'await-state'
    | 'use-ai-agent'
    | 'capability-gap-js'
    | 'report-blocked'
  /** Short instruction for the action. */
  note: string
}

/** Structured failure report. */
export interface OperatorFailureReport {
  operator: string
  phase: OperatorFailurePhase
  code: string
  message: string
  evidence?: unknown[]
  targetState?: {
    found: boolean
    ambiguous?: boolean
    stale?: boolean
  }
  retryable: boolean
  suggestedRecovery: RecoveryAction[]
  /** The failed node goal, when known (spec V24). */
  nodeGoal?: string
  /** The failed node success criteria, when known (spec V24). */
  nodeSuccessCriteria?: WorkflowCondition[]
}

/** Build a structured report from a raw error plus contextual hints. */
export function reportOperatorFailure(input: {
  operator: string
  phase?: OperatorFailurePhase
  code?: string
  message: string
  targetState?: OperatorFailureReport['targetState']
  retryable?: boolean
  nodeGoal?: string
  nodeSuccessCriteria?: WorkflowCondition[]
}): OperatorFailureReport {
  const phase = input.phase ?? inferPhase(input.message, input.code)
  const code = input.code ?? DEFAULT_CODES[phase]
  const retryable = input.retryable ?? phase !== 'unsupported'
  return {
    operator: input.operator,
    phase,
    code,
    message: input.message,
    ...(input.targetState ? { targetState: input.targetState } : {}),
    retryable,
    suggestedRecovery: recoveryFor(phase),
    ...(input.nodeGoal ? { nodeGoal: input.nodeGoal } : {}),
    ...(input.nodeSuccessCriteria ? { nodeSuccessCriteria: input.nodeSuccessCriteria } : {}),
  }
}

const DEFAULT_CODES: Record<OperatorFailurePhase, string> = {
  'target-resolution': 'TARGET_NOT_FOUND',
  precondition: 'PRECONDITION_FAILED',
  parameter: 'PARAMETER_INVALID',
  execution: 'ACTION_ERROR',
  postcondition: 'POSTCONDITION_FAILED',
  unsupported: 'UNSUPPORTED',
  unknown: 'UNKNOWN',
}

/** Infer the failure phase from a raw error message/code (best effort). */
export function inferPhase(message: string, code?: string): OperatorFailurePhase {
  const text = `${code ?? ''} ${message}`.toLowerCase()
  if (/not found|no element|target|selector|resolve|找不到|不存在/.test(text)) return 'target-resolution'
  if (/precondition|前置|前提/.test(text)) return 'precondition'
  if (/param|required|invalid|argument|参数|必填/.test(text)) return 'parameter'
  if (/postcondition|后置|not (?:the expected|observed)|未出现预期/.test(text)) return 'postcondition'
  if (/unsupported|cannot|capability|不支持|无法/.test(text)) return 'unsupported'
  if (/timeout|error|failed|错误|失败/.test(text)) return 'execution'
  return 'unknown'
}

function recoveryFor(phase: OperatorFailurePhase): RecoveryAction[] {
  switch (phase) {
    case 'target-resolution':
      return [
        { kind: 'reground', note: 'Re-snapshot the page and re-locate the target.' },
        { kind: 'retry-same', note: 'Retry the same operator once after re-grounding.' },
        { kind: 'expand-search', note: 'If re-location still fails, expand the operator search.' },
      ]
    case 'precondition':
      return [
        { kind: 'await-state', note: 'Wait for the precondition state, then retry.' },
        { kind: 'retry-same', note: 'Retry the same operator after the state holds.' },
      ]
    case 'parameter':
      return [{ kind: 'adjust-parameter', note: 'Correct the invalid parameter and retry.' }]
    case 'execution':
      return [
        { kind: 'retry-same', note: 'Retry once for a transient execution error.' },
        { kind: 'expand-search', note: 'If it fails again, search alternative operators.' },
      ]
    case 'postcondition':
      return [
        { kind: 'reground', note: 'Verify the resulting page state.' },
        { kind: 'expand-search', note: 'Goal not reached: search an operator that reaches it.' },
      ]
    case 'unsupported':
      return [
        { kind: 'expand-search', note: 'Search for a capable operator.' },
        { kind: 'use-ai-agent', note: 'For semantic output, consider the ai-agent capability.' },
      ]
    case 'unknown':
    default:
      return [{ kind: 'reground', note: 'Re-ground before taking another action.' }]
  }
}

// --- Recovery state machine ------------------------------------------------------

/** State machine states. */
export type RecoveryState =
  | 'analyze'
  | 'reground'
  | 'retry'
  | 'expand'
  | 'consider-ai'
  | 'capability-gap'
  | 'blocked'
  | 'resolved'

/** Maximum search budget (spec §12): how many operator expansions are allowed. */
export const MAX_SEARCH_EXPANSIONS = 2
export const MAX_TOTAL_CANDIDATES = 9

/** Mutable recovery session. */
export interface RecoverySession {
  state: RecoveryState
  stepIntent: string
  workflowGoal?: string
  pageSignals?: PageStructureSignals
  /** Failed operators blockId ⇒ report. */
  failures: Map<string, OperatorFailureReport>
  expansions: number
  /** Whether the execution-phase retry suggestion was already offered. */
  retryOffered?: boolean
  /** Candidates already presented (to avoid re-presenting). */
  presented: string[]
}

/** Start a recovery session after top candidates failed. */
export function startRecovery(input: {
  stepIntent: string
  workflowGoal?: string
  pageSignals?: PageStructureSignals
  failed: OperatorFailureReport[]
}): RecoverySession {
  const failures = new Map<string, OperatorFailureReport>()
  for (const report of input.failed) failures.set(report.operator, report)
  return {
    state: 'analyze',
    stepIntent: input.stepIntent,
    workflowGoal: input.workflowGoal,
    pageSignals: input.pageSignals,
    failures,
    expansions: 0,
    retryOffered: false,
    presented: input.failed.map((f) => f.operator),
  }
}

export interface RecoveryStep {
  state: RecoveryState
  /** The recovery action to take now. */
  action: RecoveryAction
  /** Present when the action is `expand-search`: the next candidate set. */
  nextCandidates?: DiscoveryResult
}

/**
 * Advance the recovery state machine by one decision.
 *
 * Decision order (spec §12):
 *   1. all failures target-resolution/precondition ⇒ re-ground, then retry same;
 *   2. parameter ⇒ adjust parameter and retry;
 *   3. semantic/unsupported ⇒ expand search for the next candidates;
 *      semantic-output needs ⇒ ai-agent appears;
 *   4. budget exhausted and still no native operator ⇒ capability-gap JS gate;
 *   5. only when even JS cannot help ⇒ blocked (with analysis).
 */
export function advanceRecovery(session: RecoverySession): RecoveryStep {
  const reports = [...session.failures.values()].filter((f) =>
    session.presented.includes(f.operator),
  )
  const latest = reports[reports.length - 1]

  if (session.state === 'analyze' || session.state === 'reground') {
    const allTarget = reports.every(
      (f) => f.phase === 'target-resolution' || f.phase === 'precondition',
    )
    // A pure precondition failure (element present, state not ready) waits for
    // the state; it must not be treated as a target-resolution failure.
    const allPrecondition = reports.every((f) => f.phase === 'precondition')
    if (allPrecondition && reports.length > 0 && session.state === 'analyze') {
      session.state = 'retry'
      return {
        state: session.state,
        action: { kind: 'await-state', note: 'Wait for the required state, then retry.' },
      }
    }
    if (allTarget && reports.length > 0 && session.state === 'analyze') {
      session.state = 'reground'
      return {
        state: session.state,
        action: { kind: 'reground', note: 'Re-snapshot and re-locate before changing operator.' },
      }
    }
    if (allTarget && session.state === 'reground') {
      session.state = 'retry'
      return {
        state: session.state,
        action: { kind: 'retry-same', note: 'Retry the same operator once after re-grounding.' },
      }
    }
  }

  if (latest?.phase === 'parameter' && session.state === 'analyze') {
    // Offer the parameter fix once; move to retry so the next decision, after
    // the fix is attempted, proceeds to search expansion instead of looping.
    session.state = 'retry'
    return {
      state: session.state,
      action: { kind: 'adjust-parameter', note: 'Fix the parameter and retry.' },
    }
  }

  // A transient execution failure retries the same operator once BEFORE any
  // search expansion. Track it via expansions-adjacent counter on state: the
  // first execution-phase decision is the retry suggestion.
  if (latest?.phase === 'execution' && session.state === 'analyze' && !session.retryOffered) {
    session.retryOffered = true
    session.state = 'retry'
    return {
      state: session.state,
      action: { kind: 'retry-same', note: 'Retry once for a transient execution error.' },
    }
  }

  // Expand search for the next, not-yet-presented candidates.
  if (session.expansions < MAX_SEARCH_EXPANSIONS) {
    const discoveryInput: DiscoveryInput = {
      stepIntent: session.stepIntent,
      workflowGoal: session.workflowGoal,
      pageSignals: session.pageSignals,
      failedOperators: Object.fromEntries(failureCodes(session.failures)),
      limit: 3,
    }
    const result = findWorkflowOperators(discoveryInput)
    const fresh = result.candidates.filter((c) => !session.presented.includes(c.blockId))
    session.expansions += 1
    if (fresh.length > 0 && session.presented.length < MAX_TOTAL_CANDIDATES) {
      session.state = 'expand'
      for (const candidate of fresh) session.presented.push(candidate.blockId)
      return {
        state: session.state,
        action: { kind: 'expand-search', note: 'Next candidates after failure analysis.' },
        nextCandidates: { ...result, candidates: fresh, candidateBlockIds: fresh.map((c) => c.blockId) },
      }
    }
  }

  // Budget exhausted. Semantic output need ⇒ ai-agent is the formal capability;
  // a true capability gap is the only path to JS.
  if (needsSemanticOutput(session.stepIntent)) {
    session.state = 'consider-ai'
    return {
      state: session.state,
      action: { kind: 'use-ai-agent', note: 'Use ai-agent for model-created semantic output.' },
    }
  }

  if (session.expansions >= MAX_SEARCH_EXPANSIONS) {
    session.state = 'capability-gap'
    return {
      state: session.state,
      action: {
        kind: 'capability-gap-js',
        note: 'No native operator after the full search budget; JS only via the capability-gap gate.',
      },
    }
  }

  session.state = 'blocked'
  return {
    state: session.state,
    action: { kind: 'report-blocked', note: 'Unable to complete even with the escape hatch.' },
  }
}

function needsSemanticOutput(text: string): boolean {
  return /(生成|写|撰写|总结|回复|generate|write|draft|summarize|reply)/i.test(text)
}

/** Reduce failure reports to blockId ⇒ code entries for failure-aware reranking. */
function failureCodes(map: Map<string, OperatorFailureReport>): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  map.forEach((report, key) => entries.push([key, report.code]))
  return entries
}

/** Record a newly failed operator into the session. */
export function recordFailure(session: RecoverySession, report: OperatorFailureReport): void {
  session.failures.set(report.operator, report)
  if (!session.presented.includes(report.operator)) session.presented.push(report.operator)
  if (session.state === 'resolved') session.state = 'analyze'
}
