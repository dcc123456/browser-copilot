/**
 * Append a finished recording to the canvas the user is already editing.
 *
 * `flowsToWorkflow` always starts with its own manual trigger. When the steps
 * are added to an existing graph that trigger is dropped, and the chain is
 * wired after the graph's only terminal node (a node with no outgoing edge) —
 * the one place where "the next step" is unambiguous. With zero or several
 * terminals there is no single continuation point, so the recorded row is
 * placed to the right and left unconnected rather than guessing.
 *
 * @module lib/workflow/record-append
 */
import { newId } from '../storage'
import type { Workflow, WorkflowEdge, WorkflowNode } from './types'

export interface CanvasGraph {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface RecordedAppendResult extends CanvasGraph {
  /** Ids of the nodes that were added, so the editor can select/reveal them. */
  addedNodeIds: string[]
  /** The node the recorded chain was wired after, when one was found. */
  connectedFrom?: string
}

const STEP_GAP_X = 240

function blockIdOf(node: WorkflowNode): string {
  return typeof node.data.blockId === 'string' ? node.data.blockId : ''
}

/**
 * Merge a recorded workflow into `current`. The recorded workflow itself is not
 * persisted; only its non-trigger steps travel.
 */
export function appendRecordedWorkflow(
  current: CanvasGraph,
  recorded: Workflow,
): RecordedAppendResult {
  const recordedNodes = recorded.drawflow.nodes.filter((node) => blockIdOf(node) !== 'trigger')
  if (recordedNodes.length === 0) {
    return { nodes: current.nodes, edges: current.edges, addedNodeIds: [] }
  }

  const terminals = current.nodes.filter(
    (node) => !current.edges.some((edge) => edge.source === node.id),
  )
  const source = terminals.length === 1 ? terminals[0] : undefined

  const startX = source
    ? source.position.x + STEP_GAP_X
    : current.nodes.length > 0
      ? Math.max(...current.nodes.map((node) => node.position.x)) + STEP_GAP_X
      : recordedNodes[0]!.position.x
  const startY = source
    ? source.position.y
    : current.nodes.length > 0
      ? Math.min(...current.nodes.map((node) => node.position.y))
      : recordedNodes[0]!.position.y

  const origin = recordedNodes[0]!.position
  const placed = recordedNodes.map((node) => ({
    ...node,
    position: {
      x: startX + (node.position.x - origin.x),
      y: startY + (node.position.y - origin.y),
    },
  }))

  const keptIds = new Set(placed.map((node) => node.id))
  // A recorded edge may start at the dropped trigger; only lines that still have
  // both ends on the canvas are carried over.
  const recordedEdges = recorded.drawflow.edges.filter(
    (edge) => keptIds.has(edge.source) && keptIds.has(edge.target),
  )
  const edges = [...current.edges, ...recordedEdges]
  const sourceBlockId = source ? blockIdOf(source) : ''
  const firstBlockId = blockIdOf(placed[0]!)
  if (source && sourceBlockId && firstBlockId) {
    edges.push({
      id: newId(),
      source: source.id,
      target: placed[0]!.id,
      sourceHandle: `${sourceBlockId}-output-1`,
      targetHandle: `${firstBlockId}-input-1`,
    })
  }

  return {
    nodes: [...current.nodes, ...placed],
    edges,
    addedNodeIds: placed.map((node) => node.id),
    ...(source ? { connectedFrom: source.id } : {}),
  }
}
