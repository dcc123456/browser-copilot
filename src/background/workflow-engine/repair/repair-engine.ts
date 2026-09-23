/**
 * WorkflowRepairEngine (spec §5.7).
 *
 * The single engine shared by the generation agent and the debug agent:
 *
 *   diagnose → propose → validatePatch → apply → replay → verify
 *
 * Pure graph analysis, patch validation and failure classification live in
 * `src/lib/workflow/repair`; the browser/provider-dependent orchestration
 * lives here. Two dependencies are injected:
 *
 *   - runner   — executes a workflow node subset (the real executeWorkflow
 *     adapter in production, a stub in tests);
 *   - provider — proposes a structured patch (the AI repair agent). When
 *     absent the engine still diagnoses, validates and verifies; `propose`
 *     simply returns null (explicit degradation, §3.2 boundary 5).
 *
 * The entry mode is never passed into the analyzer: the same workflow + trace
 * must produce the same diagnosis (§10.3).
 *
 * @module background/workflow-engine/repair/repair-engine
 */

import { PatchEngine } from '../../../lib/workflow/repair/patch-engine'
import { analyzeFailure } from './failure-analyzer'
import { canonicalizeAnalysis, sameAnalysis } from './root-cause-analyzer'
import { planReplay, executeReplay } from './replay-engine'
import {
  buildVerificationResult,
  verifyThroughRunner,
  type RunnerOutcome,
  type WorkflowRunner,
} from './verification-runner'
import type {
  ExecutionTrace,
  FailureAnalysis,
  PatchApplyResult,
  PatchValidationResult,
  RepairContext,
  ReplayOptions,
  VerificationOptions,
  VerificationResult,
  WorkflowPatchSet,
} from '../../../lib/workflow/repair/types'
import type { CheckpointStore } from '../../../lib/workflow/checkpoints'
import type { Workflow } from '../../../lib/workflow/types'

/** AI proposal provider: given context, return a patch set or null. */
export type RepairProposalProvider = (context: RepairContext) => Promise<WorkflowPatchSet | null>

export interface RepairEngineDeps {
  runner: WorkflowRunner
  store: CheckpointStore
  /** Optional AI provider; absent ⇒ propose returns null (degraded mode). */
  provider?: RepairProposalProvider
}

export class WorkflowRepairEngine {
  private readonly patchEngine: PatchEngine
  private readonly deps: RepairEngineDeps

  constructor(deps: RepairEngineDeps) {
    this.deps = deps
    this.patchEngine = new PatchEngine()
  }

  /** Deterministic diagnosis; same input always yields the same analysis. */
  diagnose(workflow: Workflow, trace: ExecutionTrace): FailureAnalysis {
    return analyzeFailure({ workflow, trace })
  }

  /** Ask the AI provider for a minimal patch (null when unavailable). */
  async propose(
    analysis: FailureAnalysis,
    context: RepairContext,
  ): Promise<WorkflowPatchSet | null> {
    if (!this.deps.provider) return null
    const proposed = await this.deps.provider(context)
    if (!proposed) return null
    // Bind the proposal to this analysis regardless of what the model set.
    return { ...proposed, analysisId: analysis.analysisId }
  }

  /** Validate a proposed patch set against the working copy. */
  validatePatch(
    workflow: Workflow,
    analysis: FailureAnalysis,
    patch: WorkflowPatchSet,
  ): PatchValidationResult {
    return this.patchEngine.validatePatch(workflow, analysis, patch)
  }

  /** Apply a validated patch to the workflow (re-validates internally). */
  apply(workflow: Workflow, analysis: FailureAnalysis, patch: WorkflowPatchSet): PatchApplyResult {
    return this.patchEngine.applyPatch(workflow, analysis, patch)
  }

  /**
   * Plan + execute a replay after a repair. AI takeover is always disabled for
   * replay (§9.4); a side-effect span requiring confirmation is not executed.
   */
  async replay(
    workflow: Workflow,
    analysis: FailureAnalysis,
    trace: ExecutionTrace,
    options: ReplayOptions = {},
  ): Promise<VerificationResult> {
    const decision = planReplay({
      workflow,
      analysis,
      trace,
      store: this.deps.store,
      ...(options.full ? { forceFull: true } : {}),
    })
    const outcome: RunnerOutcome = await executeReplay(
      workflow,
      decision,
      {
        run: (wf, runOptions) => this.deps.runner.run(wf, runOptions),
      },
      options.signal,
    )
    return buildVerificationResult({
      workflow,
      outcome,
      allowedAiTakeover: options.allowAiTakeover ?? false,
    })
  }

  /** Independent verification run (takeover disabled by default). */
  verify(workflow: Workflow, options: VerificationOptions = {}): Promise<VerificationResult> {
    return verifyThroughRunner(this.deps.runner, workflow, {
      entry: options.entry ?? 'VERIFY',
      allowAiTakeover: options.allowAiTakeover ?? false,
      ...(options.variables ? { variables: options.variables } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }
}

export { canonicalizeAnalysis, sameAnalysis }
