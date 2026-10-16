/**
 * Edge bookkeeping for newly drawn canvas connections (Automa semantics).
 *
 * One rule covers every kind of draw: an OUTPUT handle owns its edge. Drawing
 * again from the same handle MOVES that edge; drawing from any other handle
 * ADDS one, even when the target's input is already fed. So a node can be
 * reached from several branches at once — the merge two sign-in paths need
 * before they share one "logged in" step — and a fallback can land on an
 * earlier, already-wired node without severing the chain into it. Detaching a
 * branch is an explicit edge delete (double-click, or select + Delete), the
 * same as in any other flow editor.
 *
 * An identical re-draw is a no-op. Which lines render as a dashed "loop-back"
 * is decided structurally ({@link edgeClosesCycle}: the target already reaches
 * the source), not from canvas coordinates.
 *
 * @module workflow-editor/flow/connections
 */

import type { Connection, Edge, Node } from '@xyflow/react'

import { newId } from '../../lib/storage'
import { closesCycle, isFallbackHandle } from '../../lib/workflow/graph-edges'
import { branchHandlesFor } from './BlockNode'

export { isFallbackHandle }

/**
 * True when adding `source → target` to `edges` would close a directed cycle:
 * `target` can already reach `source` by following existing edges.
 *
 * Fallback edges are ignored when deciding reachability — they model error
 * recovery rather than the normal control flow, and treating them as ordinary
 * links here would misclassify draws on graphs that already carry one. An edge
 * from a node back to ITSELF is a cycle too (rejected earlier by the caller).
 *
 * The rule itself lives in {@link closesCycle} so the edit-time graph patcher
 * answers the same question the canvas does.
 */
export function edgeClosesCycle(edges: Edge[], source: string, target: string): boolean {
  return closesCycle(edges, source, target)
}

type NodeHandleInfo = {
  blockId: string
  sources: Set<string>
  /** Where an edge with an unresolvable handle is re-anchored. */
  firstSource: string
  hasTarget: boolean
}

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
    const block = node.data?.block as { id: string; inputs?: number; outputs?: number } | undefined
    if (!block) continue
    const branches = branchHandlesFor(
      block,
      node.data?.blockData as Record<string, unknown> | undefined,
    )
    const sources = new Set<string>([`${block.id}-output-fallback`])
    // A branch block draws its own ports (a conditions block's are per-path, so
    // they cannot be listed statically); every other block keeps the primary one.
    if (branches) for (const handle of branches) sources.add(`${block.id}-${handle.idSuffix}`)
    else sources.add(`${block.id}-output-1`)
    known.set(node.id, {
      blockId: block.id,
      sources,
      // An unresolvable handle lands on the topmost drawn port, so a legacy
      // `conditions-output-1` re-anchors onto the block's first path.
      firstSource: branches ? `${block.id}-${branches[0]!.idSuffix}` : `${block.id}-output-1`,
      hasTarget: (block.inputs ?? 1) > 0,
    })
  }
  return edges.map((edge) => {
    const source = known.get(edge.source)
    const target = known.get(edge.target)
    if (!source || !target) return edge
    const sourceHandle =
      edge.sourceHandle && source.sources.has(edge.sourceHandle)
        ? edge.sourceHandle
        : source.firstSource
    const targetHandle = target.hasTarget ? `${target.blockId}-input-1` : edge.targetHandle
    if (sourceHandle === edge.sourceHandle && targetHandle === edge.targetHandle) return edge
    return { ...edge, sourceHandle, targetHandle }
  })
}

/**
 * Drop the edges of `nodeId` that connect through a port the node no longer
 * draws — deleting a conditions path takes its connection with it. React Flow
 * hides such an edge anyway, so this only keeps the saved workflow from carrying
 * a handle id that names nothing. The error-fallback port is exempt: it is drawn
 * independently of the paths.
 */
export function pruneRemovedPortEdges(
  block: { id: string; outputs?: number },
  nextBlockData: Record<string, unknown>,
  nodeId: string,
  edges: Edge[],
): Edge[] {
  const branches = branchHandlesFor(block, nextBlockData)
  if (!branches) return edges
  const live = new Set(branches.map((handle) => `${block.id}-${handle.idSuffix}`))
  live.add(`${block.id}-output-fallback`)
  return edges.filter(
    (edge) =>
      edge.source !== nodeId ||
      !edge.sourceHandle ||
      live.has(edge.sourceHandle) ||
      isFallbackHandle(edge.sourceHandle),
  )
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

  // Identical re-draws stay a no-op for every kind of connection.
  if (eds.some(sameEnds)) return eds

  // Only this handle's own edge moves; every other feed of the target survives,
  // whether it is a sibling branch (a merge), a fallback, or a loop-back.
  return [
    ...eds.filter((e) => !(e.source === conn.source && e.sourceHandle === conn.sourceHandle)),
    newEdge(conn),
  ]
}
