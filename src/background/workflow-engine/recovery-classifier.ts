/**
 * Run-level unified failure classifier (spec §6 · Commit 02).
 *
 * Produces {@link FailureAnalysisV2} from the REAL execution trace and
 * checkpoint evidence. This is distinct from the single-node enriched verdict
 * in `./failure-classifier` (which serves the legacy takeover path): it ranks
 * evidence by source strength and lets the recovery orchestrator decide how
 * far it may go.
 *
 * Evidence priority (strongest first):
 *
 *   1. runner structured code   — trace.failure / node-execution TraceFailure
 *   2. block semantics          — the failing node's blockId
 *   3. trace timing / events
 *   4. checkpoint metadata      — resume decision (side-effect / mismatch / ok)
 *   5. external AI observation  — WEAKEST; accepted only as corroboration
 *
 * Invariants:
 *
 *   - a pure string error can never alone determine the final recoverability
 *     (structured evidence is required to upgrade it);
 *   - an AI observation can never, by itself, raise recoverability past
 *     SUGGEST;
 *   - insufficient evidence degrades to UNKNOWN with honest confidence;
 *   - SIDE_EFFECT is always BLOCKED and AUTH/CAPTCHA always HUMAN.
 *
 * Pure module: no `chrome`, no I/O.
 *
 * @module background/workflow-engine/recovery-classifier
 */

import {
  categoryAllowsAiPatch,
  categoryFromFailureCode,
  categoryFromVerificationFailure,
  defaultActionOf,
  defaultRecoverabilityOf,
  type FailureAnalysisV2,
  type FailureEvidenceV2,
  type RecoveryAction,
  type WorkflowFailureCategory,
} from '../../lib/workflow/repair/recovery-model'
import type {
  ExecutionTrace,
  TraceFailure,
  VerificationFailureType,
} from '../../lib/workflow/repair/types'
import type { FailureCode } from '../../lib/workflow/failure-code'
import type {
  ResumeDecision,
  RunCheckpoint,
} from '../../lib/workflow/checkpoints'
import type { Workflow } from '../../lib/workflow/types'

/** External (model-provided) observation at failure time — weakest source. */
export interface ExternalObservation {
  nodeId?: string
  detail: string
}

export interface ClassifyRunFailureInput {
  workflow: Workflow
  trace: ExecutionTrace
  /** The pure resume decision already computed over the run checkpoints. */
  resumeDecision?: ResumeDecision
  /** Optional AI-takeover structured code on the failing node. */
  failureCode?: FailureCode
  /** Optional external AI observation (never trusted alone). */
  observation?: ExternalObservation
}

/** Confidence by the strongest evidence source present. */
const SOURCE_CONFIDENCE = {
  RUNNER_CODE: 0.9,
  BLOCK: 0.72,
  TRACE: 0.62,
  CHECKPOINT: 0.7,
  AI_OBSERVATION: 0.42,
} as const

let evidenceSeq = 0
function nextEvidenceId(): string {
  evidenceSeq += 1
  return `ev-${evidenceSeq}`
}

/** The failed node's execution record, when the trace carries one. */
function failedNodeExecution(trace: ExecutionTrace, nodeId: string) {
  return trace.nodeExecutions.find((n) => n.nodeId === nodeId && n.status === 'failed')
}

/**
 * Classify a failed workflow run into the unified v2 analysis.
 */
export function classifyRunFailure(input: ClassifyRunFailureInput): FailureAnalysisV2 {
  const { workflow, trace } = input
  const evidence: FailureEvidenceV2[] = []

  const failedNodeId =
    trace.failedNodeId ||
    trace.failure?.nodeId ||
    trace.nodeExecutions.find((n) => n.status === 'failed')?.nodeId ||
    ''

  // --- Source 1: runner structured code -------------------------------------
  const failedExec = failedNodeId ? failedNodeExecution(trace, failedNodeId) : undefined
  const traceFailure: TraceFailure | undefined = trace.failure ?? failedExec?.error
  let runnerType: VerificationFailureType | undefined
  if (traceFailure) {
    runnerType = traceFailure.code
    evidence.push({
      evidenceId: nextEvidenceId(),
      kind: 'RUNNER_CODE',
      ...(traceFailure.nodeId ? { nodeId: traceFailure.nodeId } : {}),
      detail: traceFailure.message,
    })
  }

  // Optional enriched takeover code (older vocabulary).
  let codeCategory: WorkflowFailureCategory | undefined
  if (input.failureCode) {
    codeCategory = categoryFromFailureCode(input.failureCode)
    evidence.push({
      evidenceId: nextEvidenceId(),
      kind: 'RUNNER_CODE',
      ...(failedNodeId ? { nodeId: failedNodeId } : {}),
      detail: input.failureCode,
    })
  }

  // --- Source 2: block semantics --------------------------------------------
  // Only counts as evidence when the trace actually records an execution for
  // the node (the node was reached): a bare failedNodeId with no execution
  // cannot prove that block ran or why it failed.
  const nodeWasReached = trace.nodeExecutions.some(
    (n) => n.nodeId === failedNodeId && (n.status === 'ok' || n.status === 'failed'),
  )
  const failedWfNode = workflow.drawflow.nodes.find((n) => n.id === failedNodeId)
  const blockId = failedWfNode?.data?.['blockId']
  if (nodeWasReached && typeof blockId === 'string') {
    evidence.push({
      evidenceId: nextEvidenceId(),
      kind: 'BLOCK',
      nodeId: failedNodeId,
      detail: blockId,
    })
  }

  // --- Source 3: trace timing / events --------------------------------------
  const timingEvent = trace.events.find(
    (e) => e.nodeId === failedNodeId && (e.kind === 'error' || e.kind === 'result'),
  )
  if (timingEvent) {
    evidence.push({
      evidenceId: nextEvidenceId(),
      kind: 'TRACE',
      nodeId: failedNodeId,
      detail: timingEvent.text,
    })
  }

  // --- Source 4: checkpoint metadata ----------------------------------------
  let safeResume: FailureAnalysisV2['safeResumePoint']
  let sideEffectUnknown = false
  let fingerprintMismatch = false
  const resumeDecision = input.resumeDecision
  if (resumeDecision) {
    if (resumeDecision.kind === 'side-effect-unknown') {
      sideEffectUnknown = true
      evidence.push({
        evidenceId: nextEvidenceId(),
        kind: 'CHECKPOINT',
        nodeId: resumeDecision.nodeId,
        detail: `side-effect-unknown@${resumeDecision.stepIndex}`,
      })
    } else if (resumeDecision.kind === 'fingerprint-mismatch') {
      fingerprintMismatch = true
      evidence.push({
        evidenceId: nextEvidenceId(),
        kind: 'CHECKPOINT',
        ...(resumeDecision.nodeId ? { nodeId: resumeDecision.nodeId } : {}),
        detail: `fingerprint-mismatch@${resumeDecision.stepIndex}`,
      })
    } else if (resumeDecision.kind === 'ok') {
      safeResume = {
        nodeId: resumeDecision.nodeId,
        stepIndex: resumeDecision.fromStepIndex ?? 0,
        variables: resumeDecision.variables ?? {},
      }
      evidence.push({
        evidenceId: nextEvidenceId(),
        kind: 'CHECKPOINT',
        nodeId: resumeDecision.nodeId,
        detail: `resume-point@${resumeDecision.fromStepIndex ?? 0}`,
      })
    }
  }

  // --- Source 5: external AI observation (weakest) --------------------------
  if (input.observation) {
    evidence.push({
      evidenceId: nextEvidenceId(),
      kind: 'AI_OBSERVATION',
      ...(input.observation.nodeId ? { nodeId: input.observation.nodeId } : {}),
      detail: input.observation.detail,
    })
  }

  // --- Resolve category -----------------------------------------------------
  let category: WorkflowFailureCategory
  if (sideEffectUnknown) category = 'SIDE_EFFECT'
  else if (fingerprintMismatch) category = 'STRUCTURAL'
  else if (runnerType) category = categoryFromVerificationFailure(runnerType)
  else if (codeCategory) category = codeCategory
  else category = 'UNKNOWN'

  // --- Resolve recoverability -----------------------------------------------
  let recoverability = defaultRecoverabilityOf(category)
  // A proven safe resume point upgrades a non-human failure to RESUME.
  if (safeResume && (recoverability === 'AUTO' || recoverability === 'SUGGEST')) {
    recoverability = 'RESUME'
  }
  // Weak-evidence guard: with NO structured source, never claim AUTO.
  const hasStrong = Boolean(traceFailure || input.failureCode) || sideEffectUnknown || fingerprintMismatch
  if (!hasStrong && recoverability === 'AUTO') recoverability = 'SUGGEST'

  // --- Confidence: the strongest source present -----------------------------
  let confidence: number
  if (sideEffectUnknown || traceFailure || input.failureCode) {
    confidence = SOURCE_CONFIDENCE.RUNNER_CODE
  } else if (fingerprintMismatch || safeResume) {
    confidence = SOURCE_CONFIDENCE.CHECKPOINT
  } else if (nodeWasReached && blockId) {
    confidence = SOURCE_CONFIDENCE.BLOCK
  } else if (timingEvent) {
    confidence = SOURCE_CONFIDENCE.TRACE
  } else if (input.observation) {
    confidence = SOURCE_CONFIDENCE.AI_OBSERVATION
  } else {
    confidence = 0.3
  }

  // --- Recommended action ---------------------------------------------------
  const actionKind = sideEffectUnknown
    ? 'BLOCK_SIDE_EFFECT'
    : safeResume
      ? 'RESUME_CHECKPOINT'
      : defaultActionOf(category)
  const recommendedAction: RecoveryAction = {
    kind: actionKind,
    ...(failedNodeId ? { targetNodeId: failedNodeId } : {}),
    reason: `recovery:${actionKind}`,
    requiresConfirmation: recoverability !== 'AUTO',
  }

  const affectedNodeIds = new Set<string>()
  if (failedNodeId) affectedNodeIds.add(failedNodeId)
  if (safeResume) affectedNodeIds.add(safeResume.nodeId)

  return {
    analysisVersion: 2,
    failedNodeId,
    affectedNodeIds: [...affectedNodeIds],
    category,
    recoverability,
    evidence,
    recommendedAction,
    ...(safeResume ? { safeResumePoint: safeResume } : {}),
    confidence,
    explanation: `failure:${category}:${recoverability}${
      categoryAllowsAiPatch(category) ? ':ai-patchable' : ''
    }`,
  }
}

/** Re-export for callers that only want checkpoint typing here. */
export type { RunCheckpoint }
