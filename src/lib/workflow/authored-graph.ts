/**
 * Validation and assembly for workflows authored as a literal graph (nodes +
 * edges) rather than recorded from page actions. The MCP `save_workflow` tool
 * uses this to turn an externally supplied graph into a project-native
 * Workflow. Pure and chrome-free so both the agent loop and tests can use it.
 *
 * @module lib/workflow/authored-graph
 */

import { CATALOG_BY_ID } from './blocks/palette'
import type { Workflow, WorkflowEdge, WorkflowNode } from './types'

/** Upper bound per graph so a hostile or accidental payload cannot bloat storage. */
export const AUTHORED_GRAPH_LIMITS = { nodes: 500, edges: 1000 } as const

export interface AuthoredGraphInput {
  name?: unknown
  description?: unknown
  nodes?: unknown
  edges?: unknown
  trigger?: unknown
  settings?: unknown
}

export interface AuthoredGraphResult {
  workflow: Workflow | null
  errors: string[]
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readableNode(value: unknown): value is WorkflowNode {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    isRecord(value.position) &&
    typeof value.position.x === 'number' &&
    typeof value.position.y === 'number' &&
    isRecord(value.data) &&
    typeof value.data.blockId === 'string'
  )
}

function readableEdge(value: unknown): value is WorkflowEdge {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.source === 'string' &&
    typeof value.target === 'string'
  )
}

/**
 * Structural checks that go beyond `validateWorkflow`: graph reachability and
 * catalog membership. `validateWorkflow` still runs on the assembled object.
 */
export function validateAuthoredGraph(input: AuthoredGraphInput): {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : []
  const rawEdges = Array.isArray(input.edges) ? input.edges : []

  if (!Array.isArray(input.nodes) || rawNodes.length === 0) {
    errors.push('nodes must be a non-empty array')
  }
  if (!Array.isArray(input.edges)) errors.push('edges must be an array')
  if (rawNodes.length > AUTHORED_GRAPH_LIMITS.nodes) {
    errors.push(`nodes exceed the limit of ${AUTHORED_GRAPH_LIMITS.nodes}`)
  }
  if (rawEdges.length > AUTHORED_GRAPH_LIMITS.edges) {
    errors.push(`edges exceed the limit of ${AUTHORED_GRAPH_LIMITS.edges}`)
  }

  const nodes = rawNodes.filter((node): node is WorkflowNode => {
    if (!readableNode(node)) {
      errors.push('every node needs id, label, numeric position and data.blockId')
      return false
    }
    return true
  })
  const edges = rawEdges.filter((edge): edge is WorkflowEdge => {
    if (!readableEdge(edge)) {
      errors.push('every edge needs id, source and target strings')
      return false
    }
    return true
  })

  const nodeIds = new Set(nodes.map((node) => node.id))
  if (nodeIds.size !== nodes.length) errors.push('duplicate node ids')

  const edgeIds = new Set(edges.map((edge) => edge.id))
  if (edgeIds.size !== edges.length) errors.push('duplicate edge ids')

  for (const node of nodes) {
    const blockId = String(node.data.blockId)
    if (!CATALOG_BY_ID.has(blockId)) {
      errors.push(`unknown blockId "${blockId}" on node ${node.id}`)
    }
    if (node.label !== blockId) {
      warnings.push(`node ${node.id} label "${node.label}" differs from blockId "${blockId}"`)
    }
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.source))
      errors.push(`edge ${edge.id} source "${edge.source}" is not a node`)
    if (!nodeIds.has(edge.target))
      errors.push(`edge ${edge.id} target "${edge.target}" is not a node`)
    if (!edge.sourceHandle || !edge.targetHandle) {
      warnings.push(`edge ${edge.id} has no explicit handle and follows the default single edge`)
    }
  }

  const hasTriggerNode = nodes.some((node) => node.data.blockId === 'trigger')
  if (!hasTriggerNode && !isRecord(input.trigger)) {
    errors.push('a graph needs a trigger node or a trigger spec')
  }

  return { nodes, edges, errors, warnings }
}

/**
 * Assemble the missing Workflow fields around an authored graph. The caller
 * supplies `id` and timestamps (kept out of this pure module).
 */
export function assembleAuthoredWorkflow(
  input: AuthoredGraphInput,
  meta: {
    id: string
    createdAt: number
    updatedAt: number
  },
): Workflow | null {
  const { nodes, edges, errors } = validateAuthoredGraph(input)
  if (errors.length > 0) return null
  const trigger = isRecord(input.trigger)
    ? (input.trigger as unknown as Workflow['trigger'])
    : ({ type: 'manual', enabled: true } as Workflow['trigger'])
  const defaults = {
    saveLog: false,
    debugMode: false,
    notification: false,
    reuseLastState: false,
  }
  const settings = isRecord(input.settings) ? { ...defaults, ...input.settings } : defaults
  return {
    id: meta.id,
    name: String(input.name ?? '').trim(),
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
    trigger,
    settings: settings as Workflow['settings'],
    table: [],
    drawflow: { nodes, edges },
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}
