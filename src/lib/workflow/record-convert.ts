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

  let prevId = triggerId
  flows.forEach((flow, i) => {
    const id = flow.id || newId()
    nodes.push({
      id,
      label: flow.data.blockId,
      position: { x: 60 + (i + 1) * X_GAP, y: Y_START },
      data: {
        ...flow.data,
        blockId: flow.data.blockId,
        description: flow.description ?? flow.data.description ?? '',
      },
    })
    edges.push({
      id: newId(),
      source: prevId,
      target: id,
      sourceHandle: `${prevId}-output-1`,
      targetHandle: `${id}-input-1`,
    })
    prevId = id
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
