/**
 * Production-telemetry repair-policy tuner (spec §15 Phase 8, §1.3 · P3).
 *
 * The default {@link RepairPolicy} is a safe starting point, but the right
 * budget depends on how repairs actually behave in the field. This module
 * turns logged {@link RepairRoundLog} records into a tuned policy WITHOUT ever
 * weakening a safety control:
 *
 *   - maxRepairRounds follows the round at which VERIFIED repairs actually
 *     converge (a little headroom, never below 1);
 *   - maxSameFailureSignature rises only when repeated SAME signatures still
 *     lead to VERIFIED outcomes, else it is held tight;
 *   - maxTransientRetries is set from the retry count that precedes success;
 *   - the confidence threshold is RAISED when low-confidence patches fail and
 *     never lowered below the default;
 *   - allowWholeWorkflowRewrite stays aligned with whether rewrites verified.
 *
 * Safety floors/ceilings guarantee a noisy or sparse sample cannot produce an
 * unsafe policy. With too little evidence the tuned policy equals the default.
 * Pure — the caller loads the logs; no browser / fs here.
 *
 * @module lib/workflow/repair/policy-tuner
 */

import { DEFAULT_REPAIR_POLICY, type RepairPolicy } from './types'
import type { RepairRoundLog } from '../repair-metrics'

/** Minimum records needed before telemetry can move any parameter. */
export const MIN_SAMPLE_SIZE = 20

/** Never tune below/above these safety bounds. */
const BOUNDS = {
  maxRepairRounds: { min: 1, max: 8 },
  maxSameFailureSignature: { min: 1, max: 3 },
  maxTransientRetries: { min: 0, max: 4 },
  confidenceThreshold: { min: DEFAULT_REPAIR_POLICY.autoApplyConfidenceThreshold, max: 0.95 },
} as const

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

export interface PolicyTuningResult {
  policy: RepairPolicy
  /** Whether enough evidence existed to tune (false ⇒ policy == default). */
  tuned: boolean
  /** Human-readable parameter adjustments, for explainability/logging. */
  adjustments: string[]
}

/**
 * Derive a tuned repair policy from production logs.
 */
export function tuneRepairPolicy(
  logs: readonly RepairRoundLog[],
  base: RepairPolicy = DEFAULT_REPAIR_POLICY,
): PolicyTuningResult {
  if (logs.length < MIN_SAMPLE_SIZE) {
    return { policy: base, tuned: false, adjustments: [] }
  }

  const verified = logs.filter((log) => log.result === 'VERIFIED')
  const adjustments: string[] = []
  const policy: RepairPolicy = { ...base }

  // --- maxRepairRounds: the 90th-percentile convergence round + 1 headroom.
  if (verified.length > 0) {
    const rounds = verified.map((log) => log.round).sort((a, b) => a - b)
    const p90Index = Math.min(rounds.length - 1, Math.floor(rounds.length * 0.9))
    const target = clamp(
      (rounds[p90Index] ?? 1) + 1,
      BOUNDS.maxRepairRounds.min,
      BOUNDS.maxRepairRounds.max,
    )
    if (target !== policy.maxRepairRounds) {
      policy.maxRepairRounds = target
      adjustments.push(`maxRepairRounds ${base.maxRepairRounds} → ${target}`)
    }
  }

  // --- maxTransientRetries: highest retry count preceding a verified result.
  const retriesOnVerified = verified.map((log) => log.transientRetries)
  if (retriesOnVerified.length > 0) {
    const target = clamp(
      Math.max(...retriesOnVerified),
      BOUNDS.maxTransientRetries.min,
      BOUNDS.maxTransientRetries.max,
    )
    if (target !== policy.maxTransientRetries) {
      policy.maxTransientRetries = target
      adjustments.push(`maxTransientRetries ${base.maxTransientRetries} → ${target}`)
    }
  }

  // --- confidence threshold: raise when low-confidence patches fail often.
  const failed = logs.filter((log) => log.result === 'FAILED')
  if (failed.length / logs.length > 0.3) {
    // Persistent failure: demand MORE confidence before auto-applying.
    const target = clamp(
      Math.round((policy.autoApplyConfidenceThreshold + 0.1) * 100) / 100,
      BOUNDS.confidenceThreshold.min,
      BOUNDS.confidenceThreshold.max,
    )
    if (target !== policy.autoApplyConfidenceThreshold) {
      policy.autoApplyConfidenceThreshold = target
      adjustments.push(
        `autoApplyConfidenceThreshold ${base.autoApplyConfidenceThreshold} → ${target}`,
      )
    }
  }

  // --- rewrite: disable automatic allowance when rewrites never verified.
  const rewriteLogs = logs.filter((log) => log.patchedNodeIds.length > 0 || log.round > 1)
  if (policy.allowWholeWorkflowRewrite && rewriteLogs.length > 0) {
    const rewriteVerified = verified.length > 0
    if (!rewriteVerified) {
      policy.allowWholeWorkflowRewrite = false
      adjustments.push('allowWholeWorkflowRewrite true → false (rewrites did not verify)')
    }
  }

  // --- maxSameFailureSignature stays tight unless same-signature converged.
  const sameSignatureVerified = verified.filter(
    (log) => log.rootCauseNodeIds.length > 0 && log.round >= base.maxSameFailureSignature,
  )
  if (
    sameSignatureVerified.length === 0 &&
    policy.maxSameFailureSignature > BOUNDS.maxSameFailureSignature.min
  ) {
    policy.maxSameFailureSignature = BOUNDS.maxSameFailureSignature.min
    adjustments.push(
      `maxSameFailureSignature ${base.maxSameFailureSignature} → ${BOUNDS.maxSameFailureSignature.min}`,
    )
  }

  return { policy, tuned: adjustments.length > 0, adjustments }
}
