/**
 * Unified workflow failure classification model (spec §6 · Commit 02).
 *
 * This is the P0 convergence layer over the two live, partially overlapping
 * failure vocabularies:
 *
 *   - `VerificationFailureType` — `lib/workflow/repair/failure-classifier`,
 *     the de-facto canonical classifier for the run/repair loop; and
 *   - `FailureCode` — `lib/workflow/failure-code`, used only through the
 *     background enriched verdict on the AI-takeover path.
 *
 * Neither old vocabulary is removed. A `WorkflowFailureCategory` maps from
 * BOTH, and every category carries a deterministic default recoverability and
 * recommended recovery action. `UNKNOWN` is always a safe fallback.
 *
 * Pure module: no `chrome`, no DOM, no provider — so it is shared by the
 * background orchestrator and the offline tests.
 *
 * @module lib/workflow/repair/recovery-model
 */

import type { VerificationFailureType } from './types'
import type { FailureCode } from '../failure-code'

/**
 * The single, coarse failure class the product and recovery orchestrator use.
 * Kept broad on purpose: precise codes stay in the originating vocabularies.
 */
export type WorkflowFailureCategory =
  | 'TIMING'
  | 'LOCATOR'
  | 'PAGE_STATE'
  | 'NAVIGATION'
  | 'DATA'
  | 'AUTH'
  | 'CAPTCHA'
  | 'SIDE_EFFECT'
  | 'NETWORK'
  | 'PROVIDER'
  | 'STRUCTURAL'
  | 'UNKNOWN'

/**
 * Whether (and how far) the system may proceed without a human at this point.
 *
 *   AUTO     — deterministic recovery may proceed without a confirmation;
 *   SUGGEST  — an AI patch may be PROPOSED, but a human confirms applying it;
 *   RESUME   — safe to resume from a checkpoint, but not to re-run a prefix;
 *   HUMAN    — a human must act (login, captcha, confirm page state);
 *   BLOCKED  — no safe automated path; stop.
 */
export type FailureRecoverability = 'AUTO' | 'SUGGEST' | 'RESUME' | 'HUMAN' | 'BLOCKED'

/** Recovery actions the orchestrator can take (UI never selects these). */
export type RecoveryActionKind =
  | 'RETRY'
  | 'PATCH_LOCATOR'
  | 'RESUME_CHECKPOINT'
  | 'WAIT_READINESS'
  | 'PROVIDE_DATA'
  | 'REQUEST_LOGIN'
  | 'REQUEST_CAPTCHA'
  | 'BLOCK_SIDE_EFFECT'
  | 'ESCALATE_HUMAN'
  | 'NONE'

/** A concrete, evidence-backed recovery recommendation. */
export interface RecoveryAction {
  kind: RecoveryActionKind
  /** Node the action targets, when it is node-scoped. */
  targetNodeId?: string
  /** Human-readable reason (routed through i18n at the UI layer). */
  reason: string
  /** Whether this action can run without a user confirmation. */
  requiresConfirmation: boolean
}

/** One ordered piece of evidence supporting the classification. */
export interface FailureEvidenceV2 {
  evidenceId: string
  kind: 'RUNNER_CODE' | 'BLOCK' | 'TRACE' | 'CHECKPOINT' | 'AI_OBSERVATION'
  nodeId?: string
  detail: string
}

/** Safe resume point, when checkpoints prove one. */
export interface SafeResumePoint {
  nodeId: string
  stepIndex: number
  variables: Record<string, unknown>
}

/**
 * The unified, evidence-based analysis of a failed workflow run.
 *
 * `confidence` reflects how well the evidence supports the class; external AI
 * observations are the WEAKEST source and can never, by themselves, raise the
 * recoverability past `SUGGEST`.
 */
export interface FailureAnalysisV2 {
  analysisVersion: 2
  /** The failed node (where the run stopped). */
  failedNodeId: string
  /** Nodes the evidence points to as root causes (may include upstream). */
  affectedNodeIds: string[]
  category: WorkflowFailureCategory
  recoverability: FailureRecoverability
  evidence: FailureEvidenceV2[]
  recommendedAction: RecoveryAction
  /** When checkpoints support a safe resume. */
  safeResumePoint?: SafeResumePoint
  confidence: number
  explanation: string
}

// --- category mappers -------------------------------------------------------

const VERIFICATION_CATEGORY: Record<VerificationFailureType, WorkflowFailureCategory> = {
  PAGE_NOT_READY: 'TIMING',
  FRAME_NOT_READY: 'TIMING',
  TARGET_NOT_FOUND: 'LOCATOR',
  TARGET_AMBIGUOUS: 'LOCATOR',
  NETWORK_ERROR: 'NETWORK',
  WAIT_CONDITION_UNMET: 'TIMING',
  TIMEOUT: 'TIMING',
  VARIABLE_MISSING: 'DATA',
  VARIABLE_EMPTY: 'DATA',
  VARIABLE_TYPE_ERROR: 'DATA',
  CONTRACT_VIOLATION: 'DATA',
  PRECONDITION_FAILED: 'PAGE_STATE',
  POSTCONDITION_FAILED: 'SIDE_EFFECT',
  GOAL_NOT_ACHIEVED: 'PAGE_STATE',
  WRONG_ORIGIN: 'NAVIGATION',
  WRONG_PAGE: 'NAVIGATION',
  SIDE_EFFECT_UNSAFE: 'SIDE_EFFECT',
  AUTH_REQUIRED: 'AUTH',
  CAPTCHA_REQUIRED: 'CAPTCHA',
  STRUCTURAL_ERROR: 'STRUCTURAL',
  ACTION_ERROR: 'UNKNOWN',
  CANCELLED: 'UNKNOWN',
  UNKNOWN: 'UNKNOWN',
}

const FAILURE_CODE_CATEGORY: Record<FailureCode, WorkflowFailureCategory> = {
  LOCATOR_NOT_FOUND: 'LOCATOR',
  LOCATOR_AMBIGUOUS: 'LOCATOR',
  READINESS_TIMEOUT: 'TIMING',
  PRECONDITION_FAILED: 'PAGE_STATE',
  POSTCONDITION_FAILED: 'SIDE_EFFECT',
  GOAL_NOT_ACHIEVED: 'PAGE_STATE',
  SIDE_EFFECT_UNSAFE: 'SIDE_EFFECT',
  TERMINAL_STATE_UNCERTAIN: 'SIDE_EFFECT',
  WRONG_ORIGIN: 'NAVIGATION',
  WRONG_PAGE: 'NAVIGATION',
  VALIDATION_FAILED: 'STRUCTURAL',
  UPLOAD_FILE_FAILED: 'DATA',
  ELEMENT_NOT_FOUND: 'LOCATOR',
  TIMEOUT: 'TIMING',
  ABORTED: 'UNKNOWN',
  UNKNOWN: 'UNKNOWN',
}

/** Map the canonical repair-loop failure type onto a unified category. */
export function categoryFromVerificationFailure(
  type: VerificationFailureType | undefined,
): WorkflowFailureCategory {
  return type ? VERIFICATION_CATEGORY[type] : 'UNKNOWN'
}

/** Map the older failure code onto a unified category. */
export function categoryFromFailureCode(code: FailureCode | undefined): WorkflowFailureCategory {
  return code ? FAILURE_CODE_CATEGORY[code] : 'UNKNOWN'
}

// --- per-category defaults --------------------------------------------------

interface CategoryDefault {
  recoverability: FailureRecoverability
  action: RecoveryActionKind
  /** Whether the recovery may touch the page/model without a human. */
  aiPatchable: boolean
}

const CATEGORY_DEFAULT: Record<WorkflowFailureCategory, CategoryDefault> = {
  TIMING: { recoverability: 'AUTO', action: 'RETRY', aiPatchable: true },
  LOCATOR: { recoverability: 'SUGGEST', action: 'PATCH_LOCATOR', aiPatchable: true },
  PAGE_STATE: { recoverability: 'SUGGEST', action: 'WAIT_READINESS', aiPatchable: true },
  NAVIGATION: { recoverability: 'SUGGEST', action: 'ESCALATE_HUMAN', aiPatchable: true },
  DATA: { recoverability: 'SUGGEST', action: 'PROVIDE_DATA', aiPatchable: true },
  AUTH: { recoverability: 'HUMAN', action: 'REQUEST_LOGIN', aiPatchable: false },
  CAPTCHA: { recoverability: 'HUMAN', action: 'REQUEST_CAPTCHA', aiPatchable: false },
  SIDE_EFFECT: { recoverability: 'BLOCKED', action: 'BLOCK_SIDE_EFFECT', aiPatchable: false },
  NETWORK: { recoverability: 'AUTO', action: 'RETRY', aiPatchable: false },
  PROVIDER: { recoverability: 'AUTO', action: 'RETRY', aiPatchable: false },
  STRUCTURAL: { recoverability: 'SUGGEST', action: 'ESCALATE_HUMAN', aiPatchable: true },
  UNKNOWN: { recoverability: 'SUGGEST', action: 'NONE', aiPatchable: true },
}

/** Deterministic default recoverability for a category. */
export function defaultRecoverabilityOf(
  category: WorkflowFailureCategory,
): FailureRecoverability {
  return CATEGORY_DEFAULT[category].recoverability
}

/** Deterministic default recommended action for a category. */
export function defaultActionOf(category: WorkflowFailureCategory): RecoveryActionKind {
  return CATEGORY_DEFAULT[category].action
}

/** Whether an AI patch is permissible at all for a category. */
export function categoryAllowsAiPatch(category: WorkflowFailureCategory): boolean {
  return CATEGORY_DEFAULT[category].aiPatchable
}
