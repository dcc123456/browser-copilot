/**
 * Unified workflow failure taxonomy (计划 T00.6).
 *
 * ONE failure object shared by every later stage — the generated-workflow
 * validator, the execution guard, the deterministic repair library and the
 * AI-debug loop. The taxonomy deliberately supersedes the three overlapping
 * vocabularies that existed before:
 *
 *   - `failure-code.ts` `FailureCode` (runtime structured prefixes);
 *   - `repair/types.ts` `VerificationFailureType` (unified repair loop);
 *   - `ai-takeover.ts` ad-hoc reason kinds.
 *
 * Adapters (`kindFromFailureCode` / `kindFromVerificationFailure`) map both
 * older vocabularies into this one, so older call sites can be migrated
 * incrementally without a parallel taxonomy remaining.
 *
 * @module lib/workflow/failure-taxonomy
 */

import type { FailureCode } from './failure-code'
import type { VerificationFailureType } from './repair/types'

/** The 16-class failure vocabulary shared across the workflow lifecycle. */
export type WorkflowFailureKind =
  | 'intent'
  | 'planning'
  | 'graph'
  | 'dataflow'
  | 'locator-not-found'
  | 'locator-ambiguous'
  | 'locator-unstable'
  | 'readiness'
  | 'page-state'
  | 'wrong-origin'
  | 'navigation'
  | 'side-effect'
  | 'goal-verification'
  | 'runtime'
  | 'environment'
  | 'unknown'

/** The complete, ordered vocabulary (used for exhaustiveness checks). */
export const FAILURE_KINDS: readonly WorkflowFailureKind[] = [
  'intent',
  'planning',
  'graph',
  'dataflow',
  'locator-not-found',
  'locator-ambiguous',
  'locator-unstable',
  'readiness',
  'page-state',
  'wrong-origin',
  'navigation',
  'side-effect',
  'goal-verification',
  'runtime',
  'environment',
  'unknown',
]

export function isWorkflowFailureKind(value: unknown): value is WorkflowFailureKind {
  return typeof value === 'string' && (FAILURE_KINDS as readonly string[]).includes(value)
}

/**
 * ONE failed workflow step, as every repair / guard consumer must receive it.
 */
export interface WorkflowFailure {
  kind: WorkflowFailureKind
  nodeId?: string
  runId?: string
  evidence: Record<string, unknown>
  /** Whether a bounded re-observe / retry can plausibly fix the condition. */
  retryable: boolean
  /** Whether a local repair (deterministic or AI patch) can address it. */
  repairable: boolean
  /** Replaying the action blindly is dangerous — terminal state must be checked first. */
  unsafeToRetry: boolean
}

/** Default safety decisions per kind (the shared policy table). */
interface KindPolicy {
  retryable: boolean
  repairable: boolean
  unsafeToRetry: boolean
}

const KIND_POLICY: Record<WorkflowFailureKind, KindPolicy> = {
  intent: { retryable: false, repairable: true, unsafeToRetry: false },
  planning: { retryable: false, repairable: true, unsafeToRetry: false },
  graph: { retryable: false, repairable: true, unsafeToRetry: false },
  dataflow: { retryable: false, repairable: true, unsafeToRetry: false },
  'locator-not-found': { retryable: true, repairable: true, unsafeToRetry: false },
  'locator-ambiguous': { retryable: false, repairable: true, unsafeToRetry: false },
  'locator-unstable': { retryable: false, repairable: true, unsafeToRetry: false },
  readiness: { retryable: true, repairable: true, unsafeToRetry: false },
  'page-state': { retryable: true, repairable: true, unsafeToRetry: false },
  'wrong-origin': { retryable: false, repairable: true, unsafeToRetry: false },
  navigation: { retryable: true, repairable: true, unsafeToRetry: false },
  'side-effect': { retryable: false, repairable: false, unsafeToRetry: true },
  'goal-verification': { retryable: false, repairable: true, unsafeToRetry: true },
  runtime: { retryable: true, repairable: true, unsafeToRetry: false },
  environment: { retryable: false, repairable: false, unsafeToRetry: false },
  unknown: { retryable: false, repairable: false, unsafeToRetry: false },
}

/** Inputs accepted by {@link classifyWorkflowFailure}. */
export interface WorkflowFailureInput {
  kind: WorkflowFailureKind
  nodeId?: string
  runId?: string
  /** Free-form error text; preserved under `evidence.message`. */
  message?: string
  evidence?: Record<string, unknown>
  /** Explicit overrides of the kind-derived safety decisions. */
  retryable?: boolean
  repairable?: boolean
  unsafeToRetry?: boolean
}

/**
 * Build the unified failure object. Kind-derived defaults always give the
 * safety answer; callers may narrow (never broaden silently) via overrides.
 * The message, when present, is kept as evidence rather than dropped.
 */
export function classifyWorkflowFailure(input: WorkflowFailureInput): WorkflowFailure {
  const policy = KIND_POLICY[input.kind]
  const evidence: Record<string, unknown> = { ...(input.evidence ?? {}) }
  if (typeof input.message === 'string' && input.message.trim()) {
    evidence['message'] = input.message
  }
  return {
    kind: input.kind,
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    evidence,
    retryable: input.retryable ?? policy.retryable,
    repairable: input.repairable ?? policy.repairable,
    unsafeToRetry: input.unsafeToRetry ?? policy.unsafeToRetry,
  }
}

// --- Adapters from the two older vocabularies ----------------------------------

const FROM_FAILURE_CODE: Record<FailureCode, WorkflowFailureKind> = {
  LOCATOR_NOT_FOUND: 'locator-not-found',
  LOCATOR_AMBIGUOUS: 'locator-ambiguous',
  READINESS_TIMEOUT: 'readiness',
  PRECONDITION_FAILED: 'page-state',
  POSTCONDITION_FAILED: 'goal-verification',
  GOAL_NOT_ACHIEVED: 'goal-verification',
  SIDE_EFFECT_UNSAFE: 'side-effect',
  TERMINAL_STATE_UNCERTAIN: 'side-effect',
  WRONG_ORIGIN: 'wrong-origin',
  WRONG_PAGE: 'wrong-origin',
  VALIDATION_FAILED: 'graph',
  ELEMENT_NOT_FOUND: 'locator-not-found',
  TIMEOUT: 'readiness',
  ABORTED: 'unknown',
  UNKNOWN: 'unknown',
}

export function kindFromFailureCode(code: FailureCode): WorkflowFailureKind {
  return FROM_FAILURE_CODE[code] ?? 'unknown'
}

const FROM_VERIFICATION_FAILURE: Record<VerificationFailureType, WorkflowFailureKind> = {
  PAGE_NOT_READY: 'readiness',
  FRAME_NOT_READY: 'readiness',
  TARGET_NOT_FOUND: 'locator-not-found',
  TARGET_AMBIGUOUS: 'locator-ambiguous',
  NETWORK_ERROR: 'environment',
  WAIT_CONDITION_UNMET: 'readiness',
  TIMEOUT: 'readiness',
  VARIABLE_MISSING: 'dataflow',
  VARIABLE_EMPTY: 'dataflow',
  VARIABLE_TYPE_ERROR: 'dataflow',
  CONTRACT_VIOLATION: 'page-state',
  PRECONDITION_FAILED: 'page-state',
  POSTCONDITION_FAILED: 'goal-verification',
  GOAL_NOT_ACHIEVED: 'goal-verification',
  WRONG_ORIGIN: 'wrong-origin',
  WRONG_PAGE: 'wrong-origin',
  SIDE_EFFECT_UNSAFE: 'side-effect',
  AUTH_REQUIRED: 'environment',
  CAPTCHA_REQUIRED: 'environment',
  STRUCTURAL_ERROR: 'graph',
  ACTION_ERROR: 'runtime',
  CANCELLED: 'unknown',
  UNKNOWN: 'unknown',
}

export function kindFromVerificationFailure(
  type: VerificationFailureType,
): WorkflowFailureKind {
  return FROM_VERIFICATION_FAILURE[type] ?? 'unknown'
}

// --- Formatting ----------------------------------------------------------------

/** One-line, developer-facing description (logs / debug prompts). */
export function describeWorkflowFailure(failure: WorkflowFailure): string {
  const where = [
    failure.runId ? `run=${failure.runId}` : '',
    failure.nodeId ? `node=${failure.nodeId}` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const message =
    typeof failure.evidence['message'] === 'string' ? String(failure.evidence['message']) : ''
  const flags = [
    failure.retryable ? 'retryable' : 'non-retryable',
    failure.repairable ? 'repairable' : 'non-repairable',
    failure.unsafeToRetry ? 'unsafe-to-retry' : '',
  ]
    .filter(Boolean)
    .join(', ')
  return [`WorkflowFailure(${failure.kind}${where ? `, ${where}` : ''})`, message, flags]
    .filter(Boolean)
    .join(': ')
}
