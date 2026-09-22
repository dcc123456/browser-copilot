/**
 * Static + trace-backed data flow analyzer (spec §5.2, Phase 2).
 *
 * Builds the deterministic producer / transform / consumer graph:
 *
 *   - consumers — every `{{variable}}` / `{{a.b.0}}` reference each node reads
 *     (reusing the SAME token rules as `interpolate` / `dynamic-data`);
 *   - producers — from {@link buildProvenanceIndex};
 *   - edges     — PRODUCES / CONSUMES / TRANSFORMS / CONTROL_DEPENDENCY.
 *
 * Also detects dangling references, cycles and (via the trace) disambiguates
 * multi-producer variables by actual execution order. Pure — no browser.
 *
 * @module lib/workflow/repair/dataflow-analyzer
 */

import { referencesIn } from '../dynamic-data'
import {
  buildProvenanceIndex,
  provenanceOf,
  transformSourceOf,
  TRANSFORM_BLOCK_IDS,
} from './variable-provenance'
import type {
  DataDependencyEdge,
  DataFlowGraph,
  ExecutionTrace,
  VariableProvenance,
  VariableUseEvidence,
} from './types'
import { summarizeValue } from './redaction'
import type { Workflow, WorkflowNode } from '../types'

/** Every `{{variable}}` reference a node reads, with the reaching param path. */
export function consumersOfNode(
  node: WorkflowNode,
  variables: Readonly<Record<string, unknown>> = {},
): VariableUseEvidence[] {
  const out: VariableUseEvidence[] = []
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (value.includes('{{')) {
        for (const reference of referencesIn(value)) {
          const root = reference.split('.')[0] ?? reference
          out.push({
            variable: root,
            consumerNodeId: node.id,
            paramPath: path,
            resolved: Object.prototype.hasOwnProperty.call(variables, root),
            summary: summarizeValue(variables[root], root),
          })
        }
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, path ? `${path}.${index}` : String(index)))
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        walk(item, path ? `${path}.${key}` : key)
      }
    }
  }
  walk(node.data ?? {}, '')
  return out.sort((a, b) =>
    a.variable === b.variable
      ? a.paramPath.localeCompare(b.paramPath)
      : a.variable.localeCompare(b.variable),
  )
}

function isTrigger(node: WorkflowNode): boolean {
  return node.data?.['blockId'] === 'trigger'
}

/**
 * Build the data flow graph for `workflow`. When `trace` is provided its
 * actual production order resolves multi-producer cases; otherwise the graph
 * is purely static.
 */
export function analyzeDataFlow(workflow: Workflow, trace?: ExecutionTrace): DataFlowGraph {
  const staticIndex = buildProvenanceIndex(workflow)
  const producers = new Map<string, VariableProvenance[]>()
  const consumers = new Map<string, VariableUseEvidence[]>()
  const edges: DataDependencyEdge[] = []

  for (const [variable] of staticIndex) {
    producers.set(variable, provenanceOf(variable, staticIndex, trace))
  }

  for (const node of workflow.drawflow.nodes) {
    if (isTrigger(node)) continue
    const reads = consumersOfNode(node, trace ? traceFinalVariableValues(trace) : {})
    for (const use of reads) {
      const list = consumers.get(use.variable)
      if (list) list.push(use)
      else consumers.set(use.variable, [use])

      const producerList = producers.get(use.variable) ?? []
      const sourceNodeId = producerList[0]?.producerNodeId
      edges.push({
        ...(sourceNodeId ? { fromNodeId: sourceNodeId } : {}),
        variable: use.variable,
        toNodeId: node.id,
        relation: 'CONSUMES',
      })
    }

    const blockId = typeof node.data['blockId'] === 'string' ? (node.data['blockId'] as string) : ''
    const variableName = node.data?.['variableName']
    if (typeof variableName === 'string' && variableName.trim()) {
      const output = variableName.trim()
      edges.push({
        fromNodeId: node.id,
        variable: output,
        toNodeId: node.id,
        relation: TRANSFORM_BLOCK_IDS.has(blockId) ? 'TRANSFORMS' : 'PRODUCES',
      })
      if (TRANSFORM_BLOCK_IDS.has(blockId)) {
        const source = transformSourceOf(node)
        if (source) {
          const sourceProducer = producers.get(source)?.[0]?.producerNodeId
          edges.push({
            ...(sourceProducer ? { fromNodeId: sourceProducer } : {}),
            variable: source,
            toNodeId: node.id,
            relation: 'TRANSFORMS',
          })
        }
      }
    }
  }

  // Deterministic edge order.
  edges.sort((a, b) => {
    const left = `${a.variable}|${a.fromNodeId ?? ''}|${a.toNodeId}|${a.relation}`
    const right = `${b.variable}|${b.fromNodeId ?? ''}|${b.toNodeId}|${b.relation}`
    return left.localeCompare(right)
  })

  return { producers, consumers, edges }
}

function traceFinalVariableValues(trace: ExecutionTrace): Record<string, unknown> {
  // The trace keeps only summaries; a consumer is "resolved" when the summary
  // exists. Build a presence bag (value = true) — consumersOfNode only needs
  // hasOwnProperty. Real value presence for analysis comes from the analyzer.
  const out: Record<string, unknown> = {}
  for (const [name, summary] of Object.entries(trace.finalVariables)) {
    if (summary.exists) out[name] = true
  }
  return out
}

/** Variables consumed but with NO static producer and no trace production. */
export function danglingVariables(graph: DataFlowGraph, trace?: ExecutionTrace): string[] {
  const out: string[] = []
  for (const [variable] of graph.consumers) {
    const hasProducer = (graph.producers.get(variable) ?? []).length > 0
    if (hasProducer) continue
    if (
      trace &&
      trace.nodeExecutions.some((record) =>
        record.outputVariables.some((output) => output.variable === variable),
      )
    ) {
      continue
    }
    out.push(variable)
  }
  return [...new Set(out)].sort()
}

/** One link in a reverse variable chain (from a failed node upstream). */
export interface VariableChainLink {
  nodeId?: string
  variable: string
  relation: DataDependencyEdge['relation']
}

/**
 * Walk the data flow graph BACKWARD from `consumerNodeId` along the variables
 * it reads, then their producers/transforms, stopping at:
 *
 *   - a workflow input / engine alias / loop context (no producer node);
 *   - a transform whose source variable's producer is valid (spec Case C —
 *     the transform itself is the root, its upstream is NOT blamed);
 *   - a cycle (variable/node revisited) — reported as `cycle: true`.
 *
 * Returns the ordered dependency chain (consumer first) and the candidate
 * root-cause nodes reached.
 */
export function traceVariableChain(
  graph: DataFlowGraph,
  consumerNodeId: string,
): { chain: VariableChainLink[]; roots: string[]; cycle: boolean } {
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

    const incoming = graph.edges.filter(
      (edge) => edge.toNodeId === nodeId && edge.relation === 'CONSUMES',
    )
    for (const edge of incoming) {
      chain.push({ nodeId, variable: edge.variable, relation: edge.relation })
      if (visitedVariables.has(edge.variable)) {
        cycle = true
        continue
      }
      visitedVariables.add(edge.variable)

      const producerList = graph.producers.get(edge.variable) ?? []
      const nodeProducer = producerList.find((item) => item.producerNodeId)
      if (!nodeProducer?.producerNodeId) {
        // Workflow input / engine alias / loop context or dangling: chain end.
        continue
      }
      const producerNodeId = nodeProducer.producerNodeId
      if (nodeProducer.producerKind === 'TRANSFORM') {
        // The transform owns this output; do NOT recurse past it (Case C).
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
