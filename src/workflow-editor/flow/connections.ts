/**
 * Edge bookkeeping for newly drawn canvas connections (Automa semantics).
 *
 * Rules:
 * - An input handle holds a single NORMAL connection; re-drawing onto an
 *   occupied input replaces the old edge (otherwise occupied inputs — e.g. the
 *   generated set-variable → ocr link — could never be rewired). An identical
 *   re-draw is a no-op.
 * - Fallback connections are exempt on BOTH sides. A fallback edge lands on an
 *   earlier node's already-occupied input — that is the point (fall back to
 *   any previous block) — so the target's normal incoming edge must survive.
 *   A node has a single fallback branch (the engine indexes one `fallback`
 *   target per node), so re-drawing a node's fallback replaces its previous
 *   fallback edge instead of stacking a second one.
 *
 * @module workflow-editor/flow/connections
 */

import type { Connection, Edge } from '@xyflow/react'

import { newId } from '../../lib/storage'

const FALLBACK_SUFFIX = '-output-fallback'

export function isFallbackHandle(handle: string | null | undefined): boolean {
  return typeof handle === 'string' && handle.endsWith(FALLBACK_SUFFIX)
}

function newEdge(conn: Connection): Edge {
  return {
    id: newId(),
    source: conn.source,
    target: conn.target,
    sourceHandle: conn.sourceHandle,
    targetHandle: conn.targetHandle,
    type: 'custom',
  }
}

export function applyConnection(eds: Edge[], conn: Connection): Edge[] {
  if (!conn.source || !conn.target || conn.source === conn.target) return eds

  const sameEnds = (e: Edge): boolean =>
    e.source === conn.source &&
    e.sourceHandle === conn.sourceHandle &&
    e.target === conn.target &&
    e.targetHandle === conn.targetHandle

  // Identical re-draws stay a no-op for both connection kinds.
  if (eds.some(sameEnds)) return eds

  if (isFallbackHandle(conn.sourceHandle)) {
    // Move the node's single fallback branch; never disturb the target's
    // incoming edges (a fallback targets an earlier, already-wired node).
    return [
      ...eds.filter((e) => !(e.source === conn.source && e.sourceHandle === conn.sourceHandle)),
      newEdge(conn),
    ]
  }

  // Normal connection: replace the edge occupying the input handle, keeping
  // fallback edges (they attach to the same handle visually but never occupy
  // it — the fallback line coexists with the node's regular incoming edge).
  const occupiesInput = (e: Edge): boolean =>
    e.target === conn.target && e.targetHandle === conn.targetHandle && !isFallbackHandle(e.sourceHandle)
  return [...eds.filter((e) => !occupiesInput(e)), newEdge(conn)]
}
