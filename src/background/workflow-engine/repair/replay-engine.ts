/**
 * Replay engine (spec §9 · Phase 5).
 *
 * Decides WHERE a repair may re-run from and whether that point is safe:
 *
 *   1. take the earliest root-cause node along control flow;
 *   2. find the previous `ok` checkpoint;
 *   3. verify its page / tab / frame / variable snapshot can be restored;
 *   4. scan the nodes between checkpoint and failure for unsafe side effects
 *      (§9.3) — those require a state check or confirmation, never an
 *      automatic replay;
 *   5. return a {@link ReplayDecision}: checkpoint resume, full replay, or
 *      request confirmation.
 *
 * The actual execution is performed by the injected runner (see
 * {@link ReplayRunner}), so this module stays free of the driver chain and is
 * unit-testable with a stub.
 *
 * @module background/workflow-engine/repair/replay-engine
 */

import { replaySafetyOfNode } from '../../../lib/workflow/repair/patch-policy'
import type {
  ExecutionTrace,
  FailureAnalysis,
  ReplaySafety,
} from '../../../lib/workflow/repair/types'
import type { RunCheckpoint, CheckpointStore } from '../../../lib/workflow/checkpoints'
import type { Workflow, WorkflowNode } from '../../../lib/workflow/types'

export type ReplayKind = 'CHECKPOINT' | 'FULL' | 'REQUIRES_CONFIRMATION' | 'NOT_REPLAYABLE'

export interface ReplayDecision {
  kind: ReplayKind
  /** Checkpoint to resume from, when kind === CHECKPOINT. */
  checkpoint?: RunCheckpoint
  /** Node to start execution at. */
  startNodeId?: string
  /** Variables to seed the resume with. */
  variables?: Record<string, unknown>
  /** Why a checkpoint resume was refused / confirmation is needed. */
  reason?: string
}

/** Find a node by id. */
function nodeOf(workflow: Workflow, nodeId?: string): WorkflowNode | undefined {
  if (!nodeId) return undefined
  return workflow.drawflow.nodes.find((node) => node.id === nodeId)
}

/**
 * Ordered node ids along the executed path in the trace (attempts collapsed).
 */
function executedOrder(trace: ExecutionTrace): string[] {
  const order: string[] = []
  for (const record of trace.nodeExecutions) {
    if (!order.includes(record.nodeId)) order.push(record.nodeId)
  }
  return order
}

/**
 * The most severe replay safety across a set of nodes.
 */
function safetyAcross(nodes: WorkflowNode[]): ReplaySafety {
  const order: ReplaySafety[] = [
    'SAFE',
    'IDEMPOTENT',
    'REQUIRES_STATE_CHECK',
    'REQUIRES_CONFIRMATION',
    'FORBIDDEN_AUTO_REPLAY',
  ]
  let level = 0
  for (const node of nodes) {
    const safety = replaySafetyOfNode(node)
    level = Math.max(level, order.indexOf(safety))
  }
  return order[level] ?? 'REQUIRES_STATE_CHECK'
}

export interface PlanReplayInput {
  workflow: Workflow
  analysis: FailureAnalysis
  trace: ExecutionTrace
  store: CheckpointStore
  /** Set true by the caller to force a full replay. */
  forceFull?: boolean
}

/**
 * Decide how to replay after a repair (spec §9.2). Does not execute anything.
 */
export function planReplay(input: PlanReplayInput): ReplayDecision {
  const { workflow, analysis, trace, store } = input
  const order = executedOrder(trace)

  // Earliest root cause along the executed path.
  const rootPositions = analysis.rootCauseNodeIds
    .map((nodeId) => order.indexOf(nodeId))
    .filter((position) => position >= 0)
  const earliestRootPosition = rootPositions.length > 0 ? Math.min(...rootPositions) : -1

  // No safe repair / no roots: not automatically replayable.
  if (analysis.repairTarget === 'NO_SAFE_REPAIR' && rootPositions.length === 0) {
    return { kind: 'NOT_REPLAYABLE', reason: analysis.explanation }
  }

  if (input.forceFull || earliestRootPosition <= 0) {
    const startNodeId =
      earliestRootPosition >= 0 ? order[earliestRootPosition] : analysis.rootCauseNodeIds[0]
    return { kind: 'FULL', startNodeId }
  }

  // Previous ok node → the checkpoint recorded for it.
  const beforeNodeId = order[earliestRootPosition - 1]
  const checkpoints = store.load(trace.runId)
  let checkpoint: RunCheckpoint | undefined
  for (let i = checkpoints.length - 1; i >= 0; i -= 1) {
    const candidate = checkpoints[i]!
    // A point whose variable snapshot failed (spec §5.1) is not a valid resume
    // state — never silently replay it as empty variables.
    if (candidate.snapshotAvailable === false) continue
    if (
      candidate.nodeId === beforeNodeId &&
      candidate.status === 'ok' &&
      (candidate.phase === undefined || candidate.phase === 'nodeCommitted')
    ) {
      checkpoint = candidate
      break
    }
  }

  if (!checkpoint) {
    // No recoverable point: a full replay is the honest fallback.
    return {
      kind: 'FULL',
      startNodeId: order[earliestRootPosition],
      reason: 'no valid checkpoint before the root cause',
    }
  }

  // Restore-ability: node still exists; variable snapshot present.
  const rootNode = nodeOf(workflow, order[earliestRootPosition])
  if (!rootNode) {
    return { kind: 'FULL', reason: 'checkpoint target node no longer exists' }
  }

  // Side effects BETWEEN the checkpoint and the failed node (exclusive of
  // root, which is being re-executed deliberately). Unsafe effects block an
  // automatic checkpoint replay.
  const spanIds = order.slice(earliestRootPosition)
  const spanNodes = spanIds
    .map((nodeId) => nodeOf(workflow, nodeId))
    .filter((node): node is WorkflowNode => !!node)
  const safety = safetyAcross(spanNodes)
  if (safety === 'FORBIDDEN_AUTO_REPLAY' || safety === 'REQUIRES_CONFIRMATION') {
    return {
      kind: 'REQUIRES_CONFIRMATION',
      checkpoint,
      startNodeId: rootNode.id,
      variables: { ...checkpoint.variables },
      reason: `the replay span contains a ${safety} side effect`,
    }
  }

  return {
    kind: 'CHECKPOINT',
    checkpoint,
    startNodeId: rootNode.id,
    variables: { ...checkpoint.variables },
  }
}

/** Runner contract: execute a workflow node subset and return its result. */
export interface ReplayRunner {
  run(
    workflow: Workflow,
    options: {
      startAt?: string
      variables?: Record<string, unknown>
      allowAiTakeover: boolean
      entry: import('../../../lib/workflow/repair/types').TraceEntry
      signal?: AbortSignal
    },
  ): Promise<import('./verification-runner').RunnerOutcome>
}

/**
 * Execute the replay decision through `runner`.
 *
 * A FORBIDDEN/CONFIRMATION decision is never executed automatically; the
 * caller must upgrade to a confirmed run.
 */
export async function executeReplay(
  workflow: Workflow,
  decision: ReplayDecision,
  runner: ReplayRunner,
  signal?: AbortSignal,
): Promise<import('./verification-runner').RunnerOutcome> {
  if (decision.kind === 'NOT_REPLAYABLE' || decision.kind === 'REQUIRES_CONFIRMATION') {
    return {
      outcome: 'failed',
      error: decision.reason ?? 'replay requires confirmation',
      variables: decision.variables ?? {},
    }
  }
  return runner.run(workflow, {
    startAt: decision.startNodeId,
    variables: decision.variables,
    allowAiTakeover: false,
    entry: 'REPLAY',
    ...(signal ? { signal } : {}),
  })
}
