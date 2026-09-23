/**
 * The failure classifier — one failed step in, one structured verdict out
 * (spec §10, Phase 7).
 *
 * PRIORITY (why this order): page-context first (a wrong origin makes every
 * locator answer meaningless), then safety (unsafe side effects with uncertain
 * terminal state are never auto-repaired), then goal (L3 says the business
 * result failed), then the runtime contracts (readiness/conditions), then
 * locator, then legacy text codes. `classifyFailureMessage` (lib, pure) does
 * the text→code mapping; this module adds the EVIDENCE bundle and the
 * takeover-facing verdict, so the debug loop and the panel consume ONE shape.
 *
 * @module background/workflow-engine/failure-classifier
 */
import {
  classifyFailureMessage,
  type FailureClassification,
} from '../../lib/workflow/failure-code'
import {
  buildExecutionEvidence,
  type ExecutionEvidence,
} from '../../lib/workflow/execution-evidence'
import type { AiTakeoverRequest } from './engine'

/** The classifier's verdict for one failed node. */
export interface FailureVerdict extends FailureClassification {
  /** Human-readable failure line (the original message, untouched). */
  message: string
  /** The classified hint, for prompts and the run log. */
  hint: string
  /** Redacted evidence bundle (safe to log, safe to show). */
  evidence: ExecutionEvidence
  /**
   * Structured suggestion for the repair loop: what KIND of local patch may
   * fix this (never a blind replay — spec §12).
   */
  repairHint?: 'locator' | 'readiness' | 'contract' | 'none'
}

/** Raw facts the run layer has at failure time. */
export interface ClassifyFailureInput {
  /** The engine's error text for the failed node. */
  error: string
  /** Page URL at failure time, when known. */
  url?: string
  /** The failing node's selector, when the block carries one. */
  selector?: string
  /** Structured locator refusal evidence from OpResult, when present. */
  locator?: ExecutionEvidence['locator']
  /** The goal summary, when the workflow declares one. */
  goalSummary?: string
  /** Variables bag at failure time (redacted before leaving this module). */
  variables?: Record<string, unknown>
  /** Engine step lines (tail-capped inside the evidence builder). */
  stepLines?: string[]
}

/**
 * Classify one failure. The verdict inherits the message verbatim — the
 * classifier never rewrites what happened, it only adds code/category/
 * evidence/repair guidance.
 */
export function classifyFailure(input: ClassifyFailureInput): FailureVerdict {
  const classification = classifyFailureMessage(input.error)
  const repairHint: FailureVerdict['repairHint'] =
    classification.code === 'LOCATOR_NOT_FOUND' || classification.code === 'LOCATOR_AMBIGUOUS'
      ? 'locator'
      : classification.code === 'READINESS_TIMEOUT'
        ? 'readiness'
        : classification.code === 'PRECONDITION_FAILED' || classification.code === 'POSTCONDITION_FAILED'
          ? 'contract'
          : 'none'
  const evidence = buildExecutionEvidence({
    ...(input.url ? { url: input.url } : {}),
    ...(input.selector ? { selector: input.selector } : {}),
    ...(input.locator ? { locator: input.locator } : {}),
    ...(input.goalSummary ? { goalSummary: input.goalSummary } : {}),
    ...(input.variables ? { variables: input.variables } : {}),
    ...(input.stepLines?.length ? { stepLines: input.stepLines } : {}),
  })
  return {
    ...classification,
    message: input.error,
    evidence,
    ...(repairHint !== 'none' ? { repairHint } : {}),
  }
}

/**
 * Enrich an AiTakeoverRequest with the classified verdict + evidence, so the
 * takeover prompt shows the model WHY the step failed (with redacted facts)
 * instead of a bare error string. The request is mutated in place (the engine
 * owns it) and returned for convenience.
 */
export function withFailureVerdict(
  request: AiTakeoverRequest,
  input: Omit<ClassifyFailureInput, 'error'>,
): AiTakeoverRequest {
  const verdict = classifyFailure({ ...input, error: request.failedError })
  ;(
    request as AiTakeoverRequest & { failure?: FailureVerdict }
  )['failure'] = verdict
  return request
}
