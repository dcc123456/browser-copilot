/**
 * Verification runner (spec §5.5, §9.4 · Phase 5).
 *
 * Turns a raw workflow execution (the injected {@link RunnerOutcome}) into the
 * shared {@link VerificationResult}, applying the single verification rule:
 *
 * ```
 * verified = success
 *         && usedAiTakeover === false
 *         && goalAchieved !== false
 *         && structural validation clean
 * ```
 *
 * The runner is deliberately decoupled from the real `executeWorkflow`: both
 * the background integration and the tests provide a runner, so verification
 * semantics are proven without driving a browser.
 *
 * @module background/workflow-engine/repair/verification-runner
 */

import { checkWorkflowIntegrity, integrityIsClean } from '../../../lib/workflow/integrity'
import { classifyVerificationFailure } from '../../../lib/workflow/repair/failure-classifier'
import type {
  ExecutionTrace,
  TraceEntry,
  VerificationResult,
  VerificationWarning,
} from '../../../lib/workflow/repair/types'
import type { Workflow } from '../../../lib/workflow/types'

/** Raw execution outcome produced by a runner. */
export interface RunnerOutcome {
  outcome: 'ok' | 'failed' | 'cancelled'
  error?: string
  summary?: string
  variables?: Record<string, unknown>
  trace?: ExecutionTrace
}

/** Runner contract shared by the background adapter and tests. */
export interface WorkflowRunner {
  run(
    workflow: Workflow,
    options: {
      startAt?: string
      variables?: Record<string, unknown>
      allowAiTakeover: boolean
      entry: TraceEntry
      signal?: AbortSignal
    },
  ): Promise<RunnerOutcome>
}

export interface RunVerificationInput {
  workflow: Workflow
  outcome: RunnerOutcome
  /** Whether the run was allowed to use AI takeover (false for verify). */
  allowedAiTakeover: boolean
  /** Optional explicit goal verdict from the goal verifier. */
  goalAchieved?: boolean
}

/**
 * Reduce a raw outcome to a {@link VerificationResult}. Pure — given the same
 * workflow + outcome it always returns the same result.
 */
export function buildVerificationResult(input: RunVerificationInput): VerificationResult {
  const { workflow, outcome } = input
  void input.allowedAiTakeover
  const trace: ExecutionTrace = outcome.trace ?? emptyTrace(workflow, outcome)

  const success = outcome.outcome === 'ok'
  const usedAiTakeover = detectAiTakeover(trace)
  const integrity = checkWorkflowIntegrity(workflow)
  const structuralClean = integrityIsClean(integrity)

  const classified = outcome.error ? classifyVerificationFailure(outcome.error) : undefined
  const failureType =
    trace.failure?.code ?? (outcome.outcome === 'failed' ? classified?.type : undefined)

  // Warnings from the trace + integrity (integrity problems are warnings here
  // when the run still completed; a structurally-invalid SAVED workflow is
  // blocked at the commit gate, not silently marked verified).
  const warnings: VerificationWarning[] = []
  if (!structuralClean) {
    for (const dangling of integrity.danglingVars) {
      warnings.push({
        code: 'STRUCTURAL_ERROR',
        nodeId: dangling.nodeId,
        message: `dangling reference ${dangling.reference} at ${dangling.param}`,
      })
    }
    for (const nodeId of [...integrity.orphanNodes, ...integrity.unreachable]) {
      warnings.push({
        code: 'STRUCTURAL_ERROR',
        nodeId,
        message: `node ${nodeId} is not reachable`,
      })
    }
  }
  if (usedAiTakeover) {
    warnings.push({
      code: 'AI_TAKEOVER',
      message: 'the run used AI takeover; it does not verify the workflow',
    })
  }

  const executedNodes = [
    ...new Set(
      trace.nodeExecutions
        .filter((record) => record.status === 'ok' || record.status === 'failed')
        .map((record) => record.nodeId),
    ),
  ]
  const skippedNodes = [
    ...new Set(
      trace.nodeExecutions
        .filter((record) => record.status === 'skipped')
        .map((record) => record.nodeId),
    ),
  ]

  // The verification rule (spec §5.5). Allowed takeover being true only means
  // the run was permitted to use it; usedAiTakeover is what the trace proves.
  const goalAchieved = input.goalAchieved
  const verified = success && usedAiTakeover === false && goalAchieved !== false && structuralClean

  const lastCheckpoint = trace.checkpoints[trace.checkpoints.length - 1]

  return {
    success,
    verified,
    ...(goalAchieved !== undefined ? { goalAchieved } : {}),
    trace,
    ...(trace.failedNodeId ? { failedNodeId: trace.failedNodeId } : {}),
    ...(failureType ? { failureType } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    executedNodes,
    skippedNodes,
    warnings,
    ...(lastCheckpoint && outcome.outcome === 'ok'
      ? { checkpointId: lastCheckpoint.checkpointId }
      : {}),
    usedAiTakeover,
    usedFallbackReplay: trace.entry === 'REPLAY' && !lastCheckpoint,
  }
}

function detectAiTakeover(trace: ExecutionTrace): boolean {
  return trace.events.some(
    (event) => event.text.includes('AI 接管完成') || event.text.includes('AI takeover'),
  )
}

/** Trace placeholder when a runner returned none (compatibility). */
function emptyTrace(workflow: Workflow, outcome: RunnerOutcome): ExecutionTrace {
  const at = Date.now()
  return {
    traceId: `trace-empty-${at}`,
    workflowId: workflow.id,
    runId: 'unknown',
    entry: 'VERIFY',
    startedAt: at,
    finishedAt: at,
    outcome: outcome.outcome,
    events: [],
    nodeExecutions: [],
    checkpoints: [],
    finalVariables: {},
    ...(outcome.error
      ? {
          failure: {
            code: classifyVerificationFailure(outcome.error).type,
            message: outcome.error,
            retryable: classifyVerificationFailure(outcome.error).retryable,
            source: 'EXECUTOR',
          },
        }
      : {}),
  }
}

export interface VerifyThroughRunnerOptions {
  entry?: TraceEntry
  allowAiTakeover?: boolean
  variables?: Record<string, unknown>
  signal?: AbortSignal
  goalAchieved?: boolean
}

/**
 * Run `workflow` through `runner` and verify it in one step.
 *
 * Verification runs never permit takeover by default — that is what keeps the
 * result an independent proof of the workflow.
 */
export async function verifyThroughRunner(
  runner: WorkflowRunner,
  workflow: Workflow,
  options: VerifyThroughRunnerOptions = {},
): Promise<VerificationResult> {
  const allowAiTakeover = options.allowAiTakeover ?? false
  const outcome = await runner.run(workflow, {
    variables: options.variables,
    allowAiTakeover,
    entry: options.entry ?? 'VERIFY',
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return buildVerificationResult({
    workflow,
    outcome,
    allowedAiTakeover: allowAiTakeover,
    ...(options.goalAchieved !== undefined ? { goalAchieved: options.goalAchieved } : {}),
  })
}
