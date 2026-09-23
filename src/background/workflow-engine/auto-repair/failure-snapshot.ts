/**
 * Failure snapshot builder (spec §14.1).
 *
 * Builds the {@link FailureSnapshot} the autonomous repair orchestrator
 * consumes from a failed run's execution trace, the workflow node that
 * failed and the run's last checkpoint. Also tracks the last failed run per
 * workflow so an automatic trigger after a run settles can build the
 * snapshot without the caller passing the whole trace.
 *
 * @module background/workflow-engine/auto-repair/failure-snapshot
 */
import { classifyFailure, type WorkflowFailureType } from '../../../lib/workflow/failure-classification'
import { fromVerificationFailure } from '../../../lib/workflow/failure-classification'
import { getCheckpointStore } from '../run-workflow'
import type { RunCheckpoint } from '../../../lib/workflow/checkpoints'
import type { ExecutionTrace } from '../../../lib/workflow/repair/types'
import type { FailureSnapshot } from '../../../lib/workflow/repair-session'
import type { Workflow, WorkflowNode } from '../../../lib/workflow/types'

// --- Last-failed-run registry -------------------------------------------------

interface FailedRunRecord {
  runId: string
  trace: ExecutionTrace
  failedAt: number
}

const lastFailed = new Map<string, FailedRunRecord>()

/** Remember a run's failure evidence (called by the run path / auto trigger). */
export function rememberFailedRun(
  workflowId: string,
  runId: string,
  trace: ExecutionTrace,
): void {
  lastFailed.set(workflowId, { runId, trace, failedAt: Date.now() })
}

/** The last failed run evidence, when present. */
export function lastFailedRun(workflowId: string): FailedRunRecord | undefined {
  return lastFailed.get(workflowId)
}

// --- Snapshot construction ----------------------------------------------------

function blockIdOf(node: WorkflowNode | undefined): string {
  const value = node?.data?.['blockId']
  return typeof value === 'string' ? value : ''
}

function intentOf(node: WorkflowNode | undefined): string | undefined {
  const value = node?.data?.['__reliability']
  const intent = (value as { intent?: unknown } | undefined)?.['intent']
  return typeof intent === 'string' ? intent : undefined
}

function locatorOf(node: WorkflowNode | undefined): unknown {
  const data = node?.data ?? {}
  if (typeof data['selector'] === 'string') return { how: 'css', value: data['selector'] }
  if (typeof data['cssSelector'] === 'string') return { how: 'css', value: data['cssSelector'] }
  return undefined
}

function previousNodeOf(
  workflow: Workflow,
  failedNodeId: string,
): FailureSnapshot['previousNode'] {
  const index = workflow.drawflow.nodes.findIndex((node) => node.id === failedNodeId)
  if (index <= 0) return undefined
  const node = workflow.drawflow.nodes[index - 1]
  return node ? { nodeId: node.id } : undefined
}

export interface BuildSnapshotInput {
  workflow: Workflow
  runId: string
  trace: ExecutionTrace
}

/** Build a failure snapshot from a failed run's trace. */
export function buildFailureSnapshot(input: BuildSnapshotInput): FailureSnapshot {
  const { workflow, runId, trace } = input
  const failedNodeId =
    trace.failedNodeId ||
    trace.failure?.nodeId ||
    trace.nodeExecutions.find((node) => node.status === 'failed')?.nodeId ||
    ''
  const node = workflow.drawflow.nodes.find((entry) => entry.id === failedNodeId)
  const traceFailure = trace.failure
  const rawMessage = traceFailure?.message ?? 'run failed'

  let errorType: WorkflowFailureType
  if (traceFailure) {
    errorType = fromVerificationFailure(traceFailure.code)
  } else {
    errorType = classifyFailure({ message: rawMessage }).type
  }

  const page: FailureSnapshot['page'] = {
    url: trace.events.find((event) => event.nodeId === failedNodeId)?.text
      ? undefined
      : undefined,
  }
  const currentPageEvent = [...trace.events].reverse().find((event) => /https?:\/\//.test(event.text))
  if (currentPageEvent) {
    const match = currentPageEvent.text.match(/https?:\/\/\S+/)
    if (match) page.url = match[0]
  }

  const checkpoint: RunCheckpoint | undefined = getCheckpointStore().latest(runId)

  return {
    nodeId: failedNodeId,
    blockId: blockIdOf(node),
    errorType,
    errorMessage: rawMessage,
    ...(intentOf(node) ? { intent: intentOf(node) } : {}),
    page,
    ...(locatorOf(node) !== undefined ? { locator: locatorOf(node) } : {}),
    ...(previousNodeOf(workflow, failedNodeId)
      ? { previousNode: previousNodeOf(workflow, failedNodeId) }
      : {}),
    ...(checkpoint ? { checkpoint } : {}),
  }
}

/**
 * Build a snapshot for a run id: uses the remembered failed trace when
 * available, otherwise throws (the caller — the auto trigger — remembers it).
 */
export function failureSnapshotForRun(workflow: Workflow, runId: string): FailureSnapshot {
  const record = lastFailedRun(workflow.id)
  if (!record || record.runId !== runId) {
    throw new Error(`No failure evidence for run ${runId}.`)
  }
  return buildFailureSnapshot({ workflow, runId, trace: record.trace })
}
