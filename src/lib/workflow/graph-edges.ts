/**
 * Edge semantics for workflow graphs, free of React and of `chrome`.
 *
 * The canvas already needed these rules (fallback branches and loop-backs
 * coexist with a node's normal incoming edge), and the edit-time variable
 * picker needs the same answers: which edges feed a node, which ones close a
 * cycle, which nodes can run before a given node. Living in `src/lib` keeps one
 * definition for both hosts instead of a second copy the graph patcher would
 * have to invent (guidelines §5.2).
 *
 * @module lib/workflow/graph-edges
 */

/** Handle suffix a node's fallback branch connects through. */
export const FALLBACK_HANDLE_SUFFIX = '-output-fallback'

/** The minimal edge shape these rules need — `Edge` and `WorkflowEdge` both fit. */
export interface EdgeLike {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

/** Is this the output handle of a fallback branch? */
export function isFallbackHandle(handle: string | null | undefined): boolean {
  return typeof handle === 'string' && handle.endsWith(FALLBACK_HANDLE_SUFFIX)
}

/** `source → target` would close a directed cycle when `target` already reaches `source`. */
export function closesCycle(edges: readonly EdgeLike[], source: string, target: string): boolean {
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
    const current = queue.shift() as string
    for (const next of outgoing.get(current) ?? []) {
      if (next === source) return true
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return false
}

/**
 * Ids of the loop-back edges in `edges`.
 *
 * A loop-back is a normal (non-fallback) edge whose target can already reach
 * its source, i.e. a branch routed back to repeat an earlier node. It shares
 * the target's input handle with the main chain but never occupies it. Each
 * edge is tested against the FIXED graph, so callers cannot drift by testing
 * edges one at a time against a shrinking set.
 */
export function loopBackEdgeIds(edges: readonly EdgeLike[]): Set<string> {
  const ids = new Set<string>()
  for (const edge of edges) {
    if (isFallbackHandle(edge.sourceHandle)) continue
    if (closesCycle(edges, edge.source, edge.target)) ids.add(edge.id)
  }
  return ids
}

/**
 * The edges that feed `targetId` on the NORMAL control path.
 *
 * Fallback branches and loop-backs are excluded: rewiring them would move an
 * error path or a retry edge instead of the step the caller means to insert.
 * Loop-backs are decided against the whole edge set, so the same rule the
 * canvas uses when it replaces an occupied input applies here.
 */
export function incomingNormalEdges(edges: readonly EdgeLike[], targetId: string): EdgeLike[] {
  const loopBacks = loopBackEdgeIds(edges)
  return edges.filter(
    (edge) =>
      edge.target === targetId && !isFallbackHandle(edge.sourceHandle) && !loopBacks.has(edge.id),
  )
}

/**
 * Every node that can run BEFORE `targetId`, following edges backwards.
 *
 * Traverses all edges, fallback and loop-back included: both mean the source
 * ran at some point before the target, so a value it published is referenceable
 * here. That over-includes deliberately (a loop-back makes the loop body's
 * outputs look reachable from the loop head, and on iteration one they are
 * undefined) — a suggestion list may offer a name the run has not filled yet,
 * whereas save-time integrity stays the authority on what is truly dangling.
 * `targetId` itself is never in the result: a block cannot read its own output.
 */
export function reverseReachable(edges: readonly EdgeLike[], targetId: string): Set<string> {
  const incoming = new Map<string, string[]>()
  for (const edge of edges) {
    const list = incoming.get(edge.target)
    if (list) list.push(edge.source)
    else incoming.set(edge.target, [edge.source])
  }
  const seen = new Set<string>()
  const queue = [targetId]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const next of incoming.get(current) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  seen.delete(targetId)
  return seen
}
