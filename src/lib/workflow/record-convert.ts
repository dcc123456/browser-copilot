/**
 * Convert recorded browser events into a workflow (Automa's
 * recordWorkflow logic).
 *
 * The in-page recorder captures a linear sequence of "flow" entries; this
 * module turns that sequence into a node/edge graph with a manual trigger as
 * the first node and output-1 -> input-1 edges between every step.
 *
 * Recorded flow entry shape (aligned with Automa `RecordedFlow`):
 *   { id, description?, data: { blockId, <automa block fields...> } }
 *
 * @module lib/workflow/record-convert
 */

import { newId } from '../storage'
import type { Workflow, WorkflowEdge, WorkflowNode } from './types'

export interface RecordedFlow {
  id: string
  description?: string
  data: {
    blockId: string
    description?: string
    [key: string]: unknown
  }
}

export interface RecordedTab {
  url?: string
}

const X_GAP = 200
const Y_START = 180

/**
 * Build a workflow from recorded flows. The first node is a `manual-trigger`
 * (Automa begins records with the trigger block); subsequent nodes are laid
 * out left to right on a single row.
 */
export function flowsToWorkflow(
  flows: RecordedFlow[],
  opts: { name?: string } = {},
): Workflow {
  const nodes: WorkflowNode[] = []
  const edges: WorkflowEdge[] = []

  // Trigger node (Automa's `trigger` block, type manual).
  const triggerId = newId()
  nodes.push({
    id: triggerId,
    label: 'Trigger',
    position: { x: 60, y: Y_START },
    data: { blockId: 'trigger', type: 'manual', description: '' },
  })

  // React Flow edge handles reference the <Handle id> rendered on each node,
  // which is keyed by the BLOCK id (e.g. `event-click-output-1`), not the
  // unique node id — so edges must use block ids, otherwise the handles cannot
  // be resolved and no connection line is drawn.
  let prevNodeId = triggerId
  let prevBlockId = 'trigger'
  /** Signature of the previous emitted node, used to drop duplicates. */
  let prevSignature = ''

  // A single fill of a field can arrive more than once (debounced input + Enter
  // + blur flush + the trailing change event all describe the same field/value).
  // Collapse consecutive `forms` blocks that target the same field with the
  // same value so the workflow never contains a duplicated fill step.
  const signatureOf = (data: RecordedFlow['data']): string => {
    if (data.blockId === 'forms' && (data.type === 'text-field' || data.type === undefined)) {
      return `forms:${String(data.selector ?? data.cssSelector ?? '')}:${String(data.value ?? '')}`
    }
    return ''
  }

  flows.forEach((flow, i) => {
    const id = flow.id || newId()
    const blockId = flow.data.blockId
    const signature = signatureOf(flow.data)
    if (signature && signature === prevSignature) {
      // Duplicate of the node we just emitted — skip the node but keep the
      // chain (the previous node remains the predecessor for the next one).
      return
    }
    prevSignature = signature
    nodes.push({
      id,
      label: blockId,
      position: { x: 60 + (i + 1) * X_GAP, y: Y_START },
      data: {
        ...flow.data,
        blockId,
        description: flow.description ?? flow.data.description ?? '',
      },
    })
    edges.push({
      id: newId(),
      source: prevNodeId,
      target: id,
      sourceHandle: `${prevBlockId}-output-1`,
      targetHandle: `${blockId}-input-1`,
    })
    prevNodeId = id
    prevBlockId = blockId
  })

  const now = Date.now()
  return {
    id: newId(),
    name: opts.name ?? `Recorded workflow ${new Date(now).toLocaleString()}`,
    description: '',
    createdAt: now,
    updatedAt: now,
    drawflow: { nodes, edges, position: { x: 0, y: 0 }, zoom: 0.8 },
    trigger: { type: 'manual', enabled: true },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
  }
}
