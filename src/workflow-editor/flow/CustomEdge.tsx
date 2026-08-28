/**
 * Custom edge — React port of Automa's EditorCustomEdge.
 *
 * Smoothstep path with an arrow marker, a midpoint interaction area, and the
 * connected-edge highlight Automa applies while its endpoints are selected.
 * The edge is updatable: dragging the midpoint starts a new connection.
 *
 * @module workflow-editor/flow/CustomEdge
 */

import { memo } from 'react'
import {
  BaseEdge,
  getSmoothStepPath,
  type EdgeProps,
  type Edge,
} from '@xyflow/react'

export type CustomEdgeData = {
  highlighted?: boolean
  arrow?: boolean
  [key: string]: unknown
}

function CustomEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
  data,
}: EdgeProps<Edge<CustomEdgeData>>) {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  })

  const active = selected || data?.highlighted

  return (
    <>
      {/* Wide invisible interaction path so the thin edge is easy to click. */}
      <path id={`${id}-hit`} d={path} fill="none" stroke="transparent" strokeWidth={18} />
      <BaseEdge
        id={id}
        path={path}
        markerEnd={data?.arrow === false ? undefined : markerEnd}
        className={`wf-edge ${active ? 'wf-edge-active' : ''}`}
        interactionWidth={0}
        style={{
          stroke: active ? 'var(--we-edge-selected)' : 'var(--we-edge)',
          strokeWidth: active ? 2.5 : 2,
        }}
      />
    </>
  )
}

export const CustomEdge = memo(CustomEdgeComponent)

export const edgeTypes = {
  custom: CustomEdge,
}
