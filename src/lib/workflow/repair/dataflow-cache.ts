/**
 * Incremental / memoized data-flow analysis (spec §15 Phase 8 · P3).
 *
 * The repair loop calls {@link analyzeDataFlow} for the SAME graph many times
 * across rounds (a failed node is diagnosed, a patch is validated, a replay is
 * planned — all against an unchanged working copy). This module removes that
 * repeated work in two ways:
 *
 *   1. {@link memoizedDataFlow} caches the built {@link DataFlowGraph} against
 *      the workflow's structural fingerprint. Only when the graph actually
 *      changed (a patch landed) is it rebuilt; repeated diagnoses reuse the
 *      cached graph.
 *
 *   2. {@link incomingEdgeIndex} builds a CONSUMES adjacency map once so the
 *      backward root-cause walk no longer scans every edge for each node (the
 *      O(nodes × edges) hot spot in traceVariableChain's per-node filter).
 *
 * The returned graph is the SAME object for equal fingerprints, so callers
 * must treat it as read-only. Pure — no browser / provider.
 *
 * @module lib/workflow/repair/dataflow-cache
 */

import { workflowFingerprintOf } from '../checkpoints'
import { analyzeDataFlow, traceVariableChain, type VariableChainLink } from './dataflow-analyzer'
import type { DataDependencyEdge, DataFlowGraph, ExecutionTrace } from './types'
import type { Workflow } from '../types'

export interface CachedDataFlow {
  graph: DataFlowGraph
  fingerprint: string
  /** Whether this call rebuilt (true) or reused the cache (false). */
  rebuilt: boolean
}

/**
 * A reusable memoizer for data-flow graphs. One instance should live for the
 * duration of a repair session; the analyzer/orchestrator share it.
 */
export class DataFlowCache {
  private fingerprint: string | undefined
  private graph: DataFlowGraph | undefined

  /** Return the graph for `workflow`, rebuilding only when it changed. */
  get(workflow: Workflow, trace?: ExecutionTrace): CachedDataFlow {
    const fingerprint = workflowFingerprintOf(workflow)
    if (this.graph && fingerprint === this.fingerprint) {
      return { graph: this.graph, fingerprint, rebuilt: false }
    }
    const graph = analyzeDataFlow(workflow, trace)
    this.graph = graph
    this.fingerprint = fingerprint
    return { graph, fingerprint, rebuilt: true }
  }

  /** Drop the cached graph (e.g. when the trace materially changes). */
  invalidate(): void {
    this.graph = undefined
    this.fingerprint = undefined
  }
}

/**
 * Functional one-shot wrapper around a shared cache.
 */
export function memoizedDataFlow(
  cache: DataFlowCache,
  workflow: Workflow,
  trace?: ExecutionTrace,
): CachedDataFlow {
  return cache.get(workflow, trace)
}

/**
 * Build a CONSUMES incoming-edge adjacency index: toNodeId → edges that feed
 * it. Built once per graph so a backward walk is O(edges into the node) rather
 * than O(total edges) for every node visited.
 */
export function incomingEdgeIndex(graph: DataFlowGraph): Map<string, DataFlowGraph['edges']> {
  const index = new Map<string, DataFlowGraph['edges']>()
  for (const edge of graph.edges) {
    if (edge.relation !== 'CONSUMES') continue
    const list = index.get(edge.toNodeId)
    if (list) list.push(edge)
    else index.set(edge.toNodeId, [edge])
  }
  return index
}

/**
 * Backward root-cause walk using the incoming-edge index (P3 performance).
 *
 * Produces the same result as {@link traceVariableChain} but resolves a node's
 * incoming CONSUMES edges from the adjacency map (built once) instead of
 * filtering the whole edge list at every visited node. Output ordering is kept
 * identical to the reference implementation (roots sorted, same chain order).
 */
export function traceVariableChainIndexed(
  graph: DataFlowGraph,
  consumerNodeId: string,
): { chain: VariableChainLink[]; roots: string[]; cycle: boolean } {
  const incoming = incomingEdgeIndex(graph)
  const chain: VariableChainLink[] = []
  const roots = new Set<string>()
  const visitedVariables = new Set<string>()
  const visitedNodes = new Set<string>()
  let cycle = false

  const walk = (nodeId: string, depth: number): void => {
    if (depth > 64 || visitedNodes.has(nodeId)) {
      cycle = true
      return
    }
    visitedNodes.add(nodeId)

    const nodeEdges: readonly DataDependencyEdge[] = incoming.get(nodeId) ?? []
    for (const edge of nodeEdges) {
      chain.push({ nodeId, variable: edge.variable, relation: edge.relation })
      if (visitedVariables.has(edge.variable)) {
        cycle = true
        continue
      }
      visitedVariables.add(edge.variable)

      const producerList = graph.producers.get(edge.variable) ?? []
      const nodeProducer = producerList.find((item) => item.producerNodeId)
      if (!nodeProducer?.producerNodeId) continue
      const producerNodeId = nodeProducer.producerNodeId
      if (nodeProducer.producerKind === 'TRANSFORM') {
        roots.add(producerNodeId)
        chain.push({
          nodeId: producerNodeId,
          variable: edge.variable,
          relation: 'TRANSFORMS',
        })
        continue
      }
      roots.add(producerNodeId)
      walk(producerNodeId, depth + 1)
    }
  }

  walk(consumerNodeId, 0)
  return { chain, roots: [...roots].sort(), cycle }
}

/**
 * Compatibility wrapper: same signature as the reference walk but indexed.
 */
export function traceVariableChainFast(
  graph: DataFlowGraph,
  consumerNodeId: string,
): ReturnType<typeof traceVariableChain> {
  return traceVariableChainIndexed(graph, consumerNodeId)
}
