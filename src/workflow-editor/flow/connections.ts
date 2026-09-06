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

import type { Connection, Edge, Node } from '@xyflow/react'

import { newId } from '../../lib/storage'
import { BRANCH_HANDLES } from './BlockNode'

const FALLBACK_SUFFIX = '-output-fallback'

export function isFallbackHandle(handle: string | null | undefined): boolean {
  return typeof handle === 'string' && handle.endsWith(FALLBACK_SUFFIX)
}

type NodeHandleInfo = { blockId: string; sources: Set<string>; hasTarget: boolean }

/**
 * Re-anchor edges whose stored handle ids no longer resolve to a rendered
 * `<Handle>`.
 *
 * React Flow silently DROPS an edge whose `sourceHandle`/`targetHandle` does
 * not match a handle on its endpoint node: nodes stay visible, connections
 * just vanish — no console error, no warning (the "连线看不见" bug after a
 * handle-id convention drift or a save format predating branch handles). On
 * load every edge with an unknown handle is re-anchored to its node's primary
 * input/output handle; known ids (primary, branch, fallback) are kept as-is.
 */
export function healEdgeHandles(nodes: Node[], edges: Edge[]): Edge[] {
  const known = new Map<string, NodeHandleInfo>()
  for (const node of nodes) {
    const block = node.data?.block as { id: string; inputs?: number } | undefined
    if (!block) continue
    const sources = new Set<string>([`${block.id}-output-1`, `${block.id}-output-fallback`])
    for (const handle of BRANCH_HANDLES[block.id] ?? []) {
      sources.add(`${block.id}-${handle.idSuffix}`)
    }
    known.set(node.id, { blockId: block.id, sources, hasTarget: (block.inputs ?? 1) > 0 })
  }
  return edges.map((edge) => {
    const source = known.get(edge.source)
    const target = known.get(edge.target)
    if (!source || !target) return edge
    const sourceHandle =
      edge.sourceHandle && source.sources.has(edge.sourceHandle)
        ? edge.sourceHandle
        : `${source.blockId}-output-1`
    const targetHandle = target.hasTarget ? `${target.blockId}-input-1` : edge.targetHandle
    if (sourceHandle === edge.sourceHandle && targetHandle === edge.targetHandle) return edge
    return { ...edge, sourceHandle, targetHandle }
  })
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
    e.target === conn.target &&
    e.targetHandle === conn.targetHandle &&
    !isFallbackHandle(e.sourceHandle)
  return [...eds.filter((e) => !occupiesInput(e)), newEdge(conn)]
}
