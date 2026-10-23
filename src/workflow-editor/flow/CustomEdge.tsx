/**
 * Custom edge — React port of Automa's EditorCustomEdge.
 *
 * Smoothstep path with an arrow marker, a midpoint interaction area, and the
 * connected-edge highlight Automa applies while its endpoints are selected.
 * The edge is updatable: dragging the midpoint starts a new connection.
 * Optional label / animated / color fields come from the block's Lines tab.
 *
 * @module workflow-editor/flow/CustomEdge
 */

import { memo } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
  type Edge,
} from '@xyflow/react'
import { readEdgeStyle } from '../../lib/workflow/edge-data'

export type CustomEdgeData = {
  highlighted?: boolean
  arrow?: boolean
  /** True when this edge loops back to an earlier node (branch retry). */
  loopBack?: boolean
  /** Optional text drawn at the midpoint. */
  label?: string
  /** Dashes move along the connection. */
  animated?: boolean
  /** User-picked stroke color; unset keeps the theme default. */
  color?: string
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
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  })

  const active = selected || data?.highlighted
  const loopBack = data?.loopBack === true
  const { label, animated, color: customColor } = readEdgeStyle(data)
  const animatedDash = animated === true

  return (
    <>
      {/* Wide invisible interaction path so the thin edge is easy to click. */}
      <path id={`${id}-hit`} d={path} fill="none" stroke="transparent" strokeWidth={18} />
      <BaseEdge
        id={id}
        path={path}
        markerEnd={data?.arrow === false ? undefined : markerEnd}
        className={`wf-edge ${active ? 'wf-edge-active' : ''} ${
          loopBack ? 'wf-edge-loopback' : ''
        } ${animatedDash ? 'animate-edge-dash' : ''}`}
        interactionWidth={0}
        style={{
          stroke: active
            ? 'var(--we-edge-selected)'
            : customColor || (loopBack ? 'var(--we-accent)' : 'var(--we-edge)'),
          strokeWidth: active ? 2.5 : 2,
          // Dashed line marks a branch routed BACK to repeat an earlier node;
          // an animated line also needs dashes for the motion to be visible.
          strokeDasharray: loopBack || animatedDash ? '6 4' : undefined,
        }}
      />
      {label !== undefined && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded border border-border bg-panel px-1.5 py-0.5 text-[11px] text-ink shadow-sm"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const CustomEdge = memo(CustomEdgeComponent)

export const edgeTypes = {
  custom: CustomEdge,
}
