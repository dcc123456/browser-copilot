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
 * - LOOP-BACK connections are exempt just like fallbacks: a branch (conditions
 *   / element-exists / loop) routed back to an earlier, already-wired node
 *   closes a directed cycle — that edge must NOT replace the target's normal
 *   incoming edge, or the main chain breaks on the very draw meant to repeat
 *   it ("element not found → go back and retry"). The engine re-enters nodes
 *   freely (MAX_STEPS guards an infinite run), so the cycle is valid here.
 *   Whether an edge closes a cycle is decided structurally
 *   ({@link edgeClosesCycle}: the target already reaches the source), not from
 *   canvas coordinates, so disconnected/backward-placed redraws keep the
 *   ordinary replace-input behaviour.
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

/**
 * True when adding `source → target` to `edges` would close a directed cycle:
 * `target` can already reach `source` by following existing edges.
 *
 * Fallback edges are ignored when deciding reachability — they model error
 * recovery rather than the normal control flow, and treating them as ordinary
 * links here would misclassify draws on graphs that already carry one. An edge
 * from a node back to ITSELF is a cycle too (rejected earlier by the caller).
 */
export function edgeClosesCycle(
  edges: Edge[],
  source: string,
  target: string,
): boolean {
  if (source === target) return true
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    if (isFallbackHandle(edge.sourceHandle)) continue
    const list = outgoing.get(edge.source)
    if (list) list.push(edge.target)
    else outgoing.set(edge.source, [edge.target])
  }
  const seen = new Set<string>([target])
  const queue = [target]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of outgoing.get(current) ?? []) {
      if (next === source) return true
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return false
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

  // Loop-back: the draw closes a directed cycle (a branch routes back to an
  // earlier node to repeat it). Coexist with the target's normal incoming edge
  // exactly like a fallback — replacing it would sever the main chain. Re-
  // drawing from the SAME branch handle moves that branch's loop-back target.
  const closesCycle = edgeClosesCycle(eds, conn.source, conn.target)
  if (closesCycle) {
    return [
      ...eds.filter((e) => !(e.source === conn.source && e.sourceHandle === conn.sourceHandle)),
      newEdge(conn),
    ]
  }

  // Normal connection: replace the edge occupying the input handle, keeping
  // fallback AND loop-back edges (they attach to the same handle visually but
  // never occupy it — they coexist with the node's regular incoming edge).
  // Every existing edge is cycle-tested ONCE against a fixed graph, keyed by
  // id; a recomputation per compared edge would re-walk the graph each time.
  const loopBackIds = new Set<string>()
  for (const e of eds) {
    if (isFallbackHandle(e.sourceHandle)) continue
    if (edgeClosesCycle(eds, e.source, e.target)) loopBackIds.add(e.id)
  }
  const occupiesInput = (e: Edge): boolean =>
    e.target === conn.target &&
    e.targetHandle === conn.targetHandle &&
    !isFallbackHandle(e.sourceHandle) &&
    !loopBackIds.has(e.id)
  return [...eds.filter((e) => !occupiesInput(e)), newEdge(conn)]
}
