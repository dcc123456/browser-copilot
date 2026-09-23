/**
 * Low-confidence human confirmation gate (spec §6.5, §17.2 · P2).
 *
 * The deterministic analyzer and the AI patch each carry a confidence. This
 * module is the single rule deciding whether a repair may be applied
 * automatically or must be returned for explicit human confirmation:
 *
 *   autoApply = effectiveConfidence >= policy.autoApplyConfidenceThreshold
 *
 * The effective confidence is the WEAKER of the diagnosis and the proposed
 * patch — a certain diagnosis paired with an uncertain patch (or vice versa)
 * is not safe to land. When the analyzer reports ambiguity (more than one
 * root-cause candidate with no decisive winner) confidence is already low and
 * the gate simply refuses.
 *
 * §6.5 boundary: a low-confidence repair is never DROPPED — it is returned as
 * a previewable proposal the user can explicitly accept. Saving is never
 * blocked.
 *
 * Pure — no browser / provider.
 *
 * @module lib/workflow/repair/confirmation-gate
 */

import type { FailureAnalysis, RepairPolicy, WorkflowPatchSet } from './types'

/** The deciding factors the gate consumes. */
export interface ConfidenceInput {
  analysis: FailureAnalysis
  patch?: WorkflowPatchSet
  policy: RepairPolicy
}

/** Outcome of the gate. */
export interface ConfidenceDecision {
  /** Confidence the decision was based on (the weaker signal). */
  effectiveConfidence: number
  /** True only when the repair may be applied without asking. */
  autoApply: boolean
  /** True when a user must explicitly confirm before it lands. */
  requiresConfirmation: boolean
  /** Why confirmation is required (for the UI / log). */
  reason: string
}

/**
 * Decide whether the repair may auto-apply.
 *
 * Without a patch the gate judges the diagnosis alone (used before a proposal
 * exists, e.g. to decide whether even to request one automatically).
 */
export function decideConfidence(input: ConfidenceInput): ConfidenceDecision {
  const { analysis, patch, policy } = input
  const patchConfidence = patch?.confidence
  const effectiveConfidence =
    patchConfidence === undefined
      ? analysis.confidence
      : Math.min(analysis.confidence, patchConfidence)

  const autoApply = effectiveConfidence >= policy.autoApplyConfidenceThreshold
  if (autoApply) {
    return {
      effectiveConfidence,
      autoApply: true,
      requiresConfirmation: false,
      reason: '',
    }
  }

  const reason =
    effectiveConfidence < policy.autoApplyConfidenceThreshold
      ? `confidence ${effectiveConfidence.toFixed(2)} is below the auto-apply threshold ${policy.autoApplyConfidenceThreshold.toFixed(2)}; explicit confirmation required`
      : ''
  return {
    effectiveConfidence,
    autoApply: false,
    requiresConfirmation: true,
    reason,
  }
}
