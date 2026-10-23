/**
 * Optional connection styling stored on `WorkflowEdge`.
 *
 * The same three fields exist on the persisted edge and on React Flow's edge
 * `data`, so one reader serves load, save and rendering.
 *
 * @module lib/workflow/edge-data
 */

import type { WorkflowEdge } from './types'

export interface EdgeStyle {
  label?: string
  animated?: boolean
  color?: string
  [key: string]: unknown
}

/** Read the three style fields from a persisted edge or a React Flow edge. */
export function readEdgeStyle(raw: unknown): EdgeStyle {
  if (!raw || typeof raw !== 'object') return {}
  const value = raw as Record<string, unknown>
  return {
    ...(typeof value.label === 'string' && value.label !== '' ? { label: value.label } : {}),
    ...(value.animated === true ? { animated: true } : {}),
    ...(typeof value.color === 'string' && value.color !== '' ? { color: value.color } : {}),
  }
}

/** The subset of a React Flow edge this conversion needs (keeps the UI out). */
export interface CanvasEdgeShape {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
  data?: unknown
}

/**
 * A canvas edge in the shape the workflow file uses. React Flow allows `null`
 * handles, the file does not; style fields move out of `data` and onto the
 * edge itself, which is where save/load and the Lines tab read them.
 */
export function workflowEdgeOf(edge: CanvasEdgeShape): WorkflowEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? undefined,
    targetHandle: edge.targetHandle ?? undefined,
    ...readEdgeStyle(edge.data),
  }
}
