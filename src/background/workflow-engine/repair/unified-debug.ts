/**
 * Unified debug orchestration (spec §10.2 · Phase 6).
 *
 * Three explicit actions over the SAME shared engine:
 *
 *   - ANALYZE     execute → trace → diagnose; no patch, no working-copy edit;
 *   - SUGGEST     + propose → validate → pending proposal (UI preview);
 *   - AUTO_REPAIR + apply to the debug working copy → replay → verify; only a
 *                 verified result enters the pending-confirmation state.
 *
 * AI takeover is disabled for every execution here: an independent run is the
 * only proof. The formal workflow is NEVER replaced by this module — it only
 * returns a proposal/working copy for the panel's existing confirm flow.
 *
 * @module background/workflow-engine/repair/unified-debug
 */

import { WorkflowRepairEngine } from './repair-engine'
import { buildRepairContext } from './repair-agent'
import { decideConfidence } from '../../../lib/workflow/repair/confirmation-gate'
import {
  isTransientFailure,
  nextTransientRetry,
  transientPolicyOf,
  waitForTransientRetry,
} from '../../../lib/workflow/repair/transient-retry'
import { DEFAULT_REPAIR_POLICY } from '../../../lib/workflow/repair/types'
import type {
  FailureAnalysis,
  RepairContext,
  RepairRoundSummary,
  RepairPolicy,
  VerificationResult,
  WorkflowPatchSet,
} from '../../../lib/workflow/repair/types'
import type { Workflow } from '../../../lib/workflow/types'
import type { CheckpointStore } from '../../../lib/workflow/checkpoints'
import type { WorkflowRunner } from './verification-runner'

export type UnifiedDebugMode = 'ANALYZE' | 'SUGGEST' | 'AUTO_REPAIR'

export interface UnifiedDebugDeps {
  runner: WorkflowRunner
  store: CheckpointStore
  /** Optional AI proposal provider; SUGGEST/AUTO_REPAIR degrade without it. */
  propose?: (context: RepairContext) => Promise<WorkflowPatchSet | null>
  onStep?: (kind: 'info' | 'status' | 'error' | 'result', text: string) => void
  sessionId?: string
  /** Repair policy (confidence gate etc.); defaults to DEFAULT_REPAIR_POLICY. */
  policy?: import('../../../lib/workflow/repair/types').RepairPolicy
  /**
   * Set true by the caller when the user explicitly accepted a low-confidence
   * proposal. When false and confidence is below the threshold, AUTO_REPAIR
   * returns the proposal for confirmation instead of applying it (P2).
   */
  userConfirmed?: boolean
}

export interface UnifiedDebugResult {
  mode: UnifiedDebugMode
  ok: boolean
  analysis: FailureAnalysis
  verification: VerificationResult
  /** Present for SUGGEST / AUTO_REPAIR when a valid patch was produced. */
  patch?: WorkflowPatchSet
  /** Working copy after an applied patch (AUTO_REPAIR); never the formal wf. */
  workingCopy?: Workflow
  /** Why the action could not complete. */
  reason?: string
  /**
   * True when a low-confidence valid patch awaits explicit user confirmation —
   * nothing was applied. The panel re-sends AUTO_REPAIR with userConfirmed.
   */
  needsConfirmation?: boolean
}

/**
 * Run one unified debug action.
 *
 * The first pass is always a takeover-free execution whose trace feeds the
 * deterministic diagnosis.
 */
export async function runUnifiedDebug(
  workflow: Workflow,
  mode: UnifiedDebugMode,
  deps: UnifiedDebugDeps,
): Promise<UnifiedDebugResult> {
  const engine = new WorkflowRepairEngine({
    runner: deps.runner,
    store: deps.store,
    ...(deps.propose ? { provider: deps.propose } : {}),
  })
  const log = (kind: 'info' | 'status' | 'error' | 'result', text: string): void =>
    deps.onStep?.(kind, text)

  const policy: RepairPolicy = deps.policy ?? DEFAULT_REPAIR_POLICY

  // 1. Independent execution.
  log('status', 'Running the workflow without AI takeover…')
  let verification = await engine.verify(workflow, { entry: 'DEBUG' })
  // 2. Deterministic diagnosis from the real trace.
  let analysis = engine.diagnose(workflow, verification.trace)

  // §6.3: bounded transient retries BEFORE any patch. ANALYZE still reports
  // the diagnosis (including retryRecommended), but does not retry; SUGGEST /
  // AUTO_REPAIR spend the shared transient budget first.
  if (mode !== 'ANALYZE' && !verification.verified) {
    const transientPolicy = transientPolicyOf(policy)
    let transientRetries = 0
    while (
      analysis.retryRecommended ||
      isTransientFailure(analysis.failureType, verification.trace.failure?.retryable)
    ) {
      const retry = nextTransientRetry({ retries: transientRetries }, transientPolicy)
      if (!retry) {
        log('status', 'Transient retry budget exhausted; proceeding to a minimal patch.')
        break
      }
      transientRetries += 1
      log(
        'status',
        `Bounded transient retry ${transientRetries}/${transientPolicy.maxRetries} in ${retry.delayMs}ms…`,
      )
      await waitForTransientRetry(retry.delayMs)
      verification = await engine.verify(workflow, { entry: 'DEBUG' })
      analysis = engine.diagnose(workflow, verification.trace)
      if (verification.verified) {
        log('result', 'Recovered after a bounded transient retry; no patch needed.')
        return {
          mode,
          ok: true,
          analysis,
          verification,
          ...(mode === 'AUTO_REPAIR' ? { workingCopy: workflow } : {}),
        }
      }
    }
  }

  log('result', analysis.explanation)

  if (mode === 'ANALYZE') {
    return { mode, ok: verification.verified, analysis, verification }
  }

  // SUGGEST / AUTO_REPAIR need a patch: nothing to do when already verified.
  if (verification.verified) {
    return {
      mode,
      ok: true,
      analysis,
      verification,
      ...(mode === 'AUTO_REPAIR' ? { workingCopy: workflow } : {}),
    }
  }

  const history: RepairRoundSummary[] = []
  const context = buildRepairContext(workflow, verification.trace, analysis, history)
  log('status', 'Requesting a minimal patch proposal…')
  const proposed = await engine.propose(analysis, context)
  if (!proposed) {
    return {
      mode,
      ok: false,
      analysis,
      verification,
      reason: deps.propose ? 'no patch proposed' : 'provider unavailable',
    }
  }

  // Validate before anything is kept.
  const validation = engine.validatePatch(workflow, analysis, proposed)
  if (!validation.ok) {
    return {
      mode,
      ok: false,
      analysis,
      verification,
      patch: proposed,
      reason: validation.issues.map((issue) => issue.message).join('; '),
    }
  }

  if (mode === 'SUGGEST') {
    // Only a preview: no working-copy change.
    return { mode, ok: true, analysis, verification, patch: proposed }
  }

  // Confidence gate (P2, spec §6.5/§17.2): a valid but low-confidence patch is
  // not applied without the user's explicit confirmation. Return it as a
  // preview (needsConfirmation) — never drop it, never mutate the working copy.
  const confidence = decideConfidence({ analysis, patch: proposed, policy })
  if (confidence.requiresConfirmation && !deps.userConfirmed) {
    log('status', 'Low confidence: waiting for explicit user confirmation.')
    return {
      mode,
      ok: false,
      analysis,
      verification,
      patch: proposed,
      reason: confidence.reason,
      needsConfirmation: true,
    }
  }

  // AUTO_REPAIR: apply to a debug working copy, then replay + verify.
  log('status', 'Applying the patch to the debug working copy…')
  const applied = engine.apply(workflow, analysis, proposed)
  const workingCopy = applied.workflow

  log('status', 'Replaying the repaired working copy…')
  const replay = await engine.replay(workingCopy, analysis, verification.trace)

  if (!replay.verified) {
    // Keep the working copy + evidence; the formal workflow is untouched.
    return {
      mode,
      ok: false,
      analysis,
      verification: replay,
      patch: proposed,
      workingCopy,
      reason: replay.error ?? 'replay did not verify',
    }
  }

  log('result', 'Repair verified: the workflow runs independently without AI takeover.')
  return {
    mode,
    ok: true,
    analysis,
    verification: replay,
    patch: proposed,
    workingCopy,
  }
}
