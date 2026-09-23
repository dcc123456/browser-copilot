/**
 * Cross-sub-workflow trace helpers (P3, spec §15 Phase 8).
 *
 * With {@link ExecutionTrace.workflowPath} and per-node
 * `workflowPathIndex`, a failure inside a nested child can be attributed to
 * the exact node AND expressed as a qualified path (root→child). These are the
 * read-side helpers the analyzer / UI use. Pure.
 *
 * @module lib/workflow/repair/subworkflow-trace
 */

import type { ExecutionTrace, NodeExecutionTrace } from './types'

/** The workflow id a node execution ran in, resolved from the workflow path. */
export function workflowOfNode(
  trace: ExecutionTrace,
  node: NodeExecutionTrace,
): string | undefined {
  const path = trace.workflowPath ?? [trace.workflowId]
  const index = node.workflowPathIndex ?? 0
  return path[index]
}

/**
 * Qualified node path (workflow ids root→child) for a node execution, e.g.
 * `["parent-wf", "child-wf"]` — or just `[rootId]` for a root node.
 */
export function nodeWorkflowPath(trace: ExecutionTrace, node: NodeExecutionTrace): string[] {
  const path = trace.workflowPath ?? [trace.workflowId]
  const index = node.workflowPathIndex ?? 0
  return path.slice(0, index + 1)
}

/**
 * Find the execution record for a node id, preferring the deepest nested one
 * (a node id can recur across parent/child) so a child failure is attributed
 * inside the child rather than resolved to a same-id root node.
 */
export function findNodeExecution(
  trace: ExecutionTrace,
  nodeId: string,
): NodeExecutionTrace | undefined {
  let best: NodeExecutionTrace | undefined
  for (const node of trace.nodeExecutions) {
    if (node.nodeId !== nodeId) continue
    if (!best || (node.workflowPathIndex ?? 0) > (best.workflowPathIndex ?? 0)) {
      best = node
    }
  }
  return best
}

/**
 * True when the failed node sits inside a nested sub-workflow rather than the
 * root workflow.
 */
export function failureIsInSubWorkflow(trace: ExecutionTrace): boolean {
  const failedNodeId = trace.failedNodeId
  if (!failedNodeId) return false
  const node = findNodeExecution(trace, failedNodeId)
  return (node?.workflowPathIndex ?? 0) > 0
}

/**
 * Stable qualified identifier for a node, e.g. `parent-wf/child-wf::nodeId`.
 * Useful for deterministic failure signatures that must distinguish the same
 * node id at different nesting levels.
 */
export function qualifiedNodeId(trace: ExecutionTrace, node: NodeExecutionTrace): string {
  return `${nodeWorkflowPath(trace, node).join('/')}::${node.nodeId}`
}
