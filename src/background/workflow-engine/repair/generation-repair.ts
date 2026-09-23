/**
 * Generation repair loop (spec §10.1 · Phase 7).
 *
 * Runs the already-formed generated working copy through the SAME repair
 * engine the debug path uses: verify → diagnose → propose → validate → apply →
 * replay. First-pass verification never permits AI takeover.
 *
 * Outcome:
 *
 *   - VERIFIED → the working copy may be formally committed;
 *   - DRAFT    → non-structural failure with the repair budget exhausted, the
 *                draft is preserved with the last analysis;
 *   - BLOCKED  → structural failure / safety policy, formal commit is blocked
 *                but the session is kept recoverable.
 *
 * The module never calls `resolveWorkflowForSave` or `workflows.save`: the
 * caller owns the commit decision; this only produces the repair result.
 *
 * @module background/workflow-engine/repair/generation-repair
 */

import { WorkflowRepairEngine } from './repair-engine'
import { buildRepairContext } from './repair-agent'
import { decideConfidence } from '../../../lib/workflow/repair/confirmation-gate'
import type {
  FailureAnalysis,
  RepairContext,
  RepairPolicy,
  VerificationResult,
  WorkflowPatchSet,
} from '../../../lib/workflow/repair/types'
import { DEFAULT_REPAIR_POLICY } from '../../../lib/workflow/repair/types'
import type { Workflow } from '../../../lib/workflow/types'
import type { CheckpointStore } from '../../../lib/workflow/checkpoints'
import type { WorkflowRunner } from './verification-runner'

export type GenerationRepairStatus = 'VERIFIED' | 'DRAFT' | 'BLOCKED'

export interface GenerationRepairResult {
  status: GenerationRepairStatus
  workingCopy: Workflow
  lastVerification: VerificationResult
  lastAnalysis?: FailureAnalysis
  patches: WorkflowPatchSet[]
  reason?: string
}

export interface GenerationRepairDeps {
  runner: WorkflowRunner
  store: CheckpointStore
  propose?: (context: RepairContext) => Promise<WorkflowPatchSet | null>
  policy?: Partial<RepairPolicy>
  onStep?: (kind: 'info' | 'status' | 'error' | 'result', text: string) => void
}

/**
 * Finalize a generated workflow through the unified repair loop.
 *
 * Mirrors the pseudocode in spec §10.1 exactly: the first independent
 * verify, a structural short-circuit, bounded transient retries handled by
 * the caller's runner (retryRecommended), then minimal patches until the
 * budget is exhausted.
 */
export async function finalizeGeneratedWorkflow(
  workflow: Workflow,
  deps: GenerationRepairDeps,
): Promise<GenerationRepairResult> {
  const policy: RepairPolicy = { ...DEFAULT_REPAIR_POLICY, ...deps.policy }
  const engine = new WorkflowRepairEngine({
    runner: deps.runner,
    store: deps.store,
    ...(deps.propose ? { provider: deps.propose } : {}),
  })
  const log = (kind: 'info' | 'status' | 'error' | 'result', text: string): void =>
    deps.onStep?.(kind, text)

  let workingCopy = workflow
  const patches: WorkflowPatchSet[] = []
  const deadline = Date.now() + policy.maxTotalDurationMs

  for (let round = 0; round < policy.maxRepairRounds; round += 1) {
    if (Date.now() > deadline) break

    const verification = await engine.verify(workingCopy, { entry: 'GENERATION' })
    if (verification.verified) {
      log('result', 'Generated workflow verified without AI takeover.')
      return { status: 'VERIFIED', workingCopy, lastVerification: verification, patches }
    }

    const analysis = engine.diagnose(workingCopy, verification.trace)

    // Structural failure blocks the formal commit; the session stays intact.
    if (analysis.failureType === 'STRUCTURAL_ERROR') {
      log('error', analysis.explanation)
      return {
        status: 'BLOCKED',
        workingCopy,
        lastVerification: verification,
        lastAnalysis: analysis,
        patches,
        reason: analysis.explanation,
      }
    }

    // retryRecommended is surfaced; the next verify pass is the bounded retry
    // when the runner supports it. No patch is generated for transient causes.
    if (analysis.retryRecommended && round < policy.maxRepairRounds - 1) {
      log('status', `${analysis.explanation} Retrying…`)
      workingCopy = { ...workingCopy, updatedAt: workingCopy.updatedAt }
      continue
    }

    const context = buildRepairContext(workingCopy, verification.trace, analysis, [])
    const patch = await engine.propose(analysis, context)
    if (!patch) break

    const validation = engine.validatePatch(workingCopy, analysis, patch)
    if (!validation.ok) {
      log('error', `Patch rejected: ${validation.issues.map((i) => i.message).join('; ')}`)
      break
    }

    // Confidence gate (P2, spec §6.5): a valid but low-confidence patch is not
    // applied automatically in generation mode (there is no user present to
    // confirm). Preserve the workflow as a DRAFT carrying the diagnosis rather
    // than mutating it on an uncertain signal.
    const confidence = decideConfidence({ analysis, patch, policy })
    if (confidence.requiresConfirmation) {
      log('error', `Low confidence, not auto-applying: ${confidence.reason}`)
      return {
        status: 'DRAFT',
        workingCopy,
        lastVerification: verification,
        lastAnalysis: analysis,
        patches,
        reason: confidence.reason,
      }
    }

    workingCopy = engine.apply(workingCopy, analysis, patch).workflow
    patches.push(patch)

    const replay = await engine.replay(workingCopy, analysis, verification.trace)
    if (replay.verified) {
      log('result', 'Generated workflow verified after a repaired replay.')
      return {
        status: 'VERIFIED',
        workingCopy,
        lastVerification: replay,
        lastAnalysis: analysis,
        patches,
      }
    }
  }

  // Budget exhausted on a non-structural failure: preserve the draft.
  const lastVerification = await engine.verify(workingCopy, { entry: 'GENERATION' })
  const lastAnalysis = engine.diagnose(workingCopy, lastVerification.trace)
  log('error', 'Repair budget exhausted; preserving the workflow as a draft.')
  return {
    status: lastAnalysis.failureType === 'STRUCTURAL_ERROR' ? 'BLOCKED' : 'DRAFT',
    workingCopy,
    lastVerification,
    lastAnalysis,
    patches,
    reason: 'repair budget exhausted',
  }
}
