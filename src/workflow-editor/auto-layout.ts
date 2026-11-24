/**
 * One-click graph beautify — a dependency-free layered (Sugiyama-style)
 * auto-layout for the workflow canvas.
 *
 * Each rank is a vertical column and ranks advance left→right. A typical graph
 * stays on one horizontal axis; a graph too wide to read is split into
 * left-aligned rows so fit-view can show the whole flow without shrinking the
 * cards to illegibility. Wrap connectors may turn back between ADJACENT rows,
 * but never sweep back across several rows.
 *
 * Edges that would close a cycle — a fallback that retries an earlier block, a
 * loop that runs back to its head — are EXCLUDED from layer assignment. They
 * still render, but they do not decide where cards belong. Ordering is derived
 * from stable node ids, never from the stored array order.
 *
 * @module workflow-editor/auto-layout
 */

import { isFallbackHandle } from '../lib/workflow/graph-edges'

export interface LayoutInputNode {
  id: string
  measured?: { width?: number; height?: number }
  width?: number
  height?: number
}
export interface LayoutInputEdge {
  source: string
  target: string
  /**
   * The drawn handle the edge leaves from. A fallback port (onError) is an error
   * path, never the next step of the flow, so it must not become a layer.
   */
  sourceHandle?: string | null
}
export interface LayoutPoint {
  x: number
  y: number
}

export interface AutoLayoutOptions {
  /** Fallback node size when the node hasn't been measured yet. */
  nodeWidth?: number
  nodeHeight?: number
  /** Horizontal gap between layers (px). */
  hGap?: number
  /** Vertical gap between nodes in the same layer (px). */
  vGap?: number
  /** Preferred row width; a small graph may exceed it while staying readable. */
  maxRowWidth?: number
  /** Vertical gap between rows (px). */
  rowGap?: number
}

const DEFAULTS = {
  nodeWidth: 200,
  nodeHeight: 64,
  hGap: 70,
  vGap: 36,
  maxRowWidth: 1600,
  rowGap: 90,
}

/**
 * Indexes of the edges that must not become a layer.
 *
 * Two sources, in order of reliability:
 * 1. The edge leaves an onError fallback port. That port is an error path by
 *    definition, so it is excluded without guessing.
 * 2. Anything left inside a cycle. Cycles are found as strongly connected
 *    components; within one, every node is ranked by its distance from the
 *    component's ENTRY (the node the flow arrives from, i.e. one with an
 *    incoming edge from another component), and the edges pointing back up that
 *    order are the retries. This is what makes "loop body → breakpoint → loop
 *    head" break the return edge rather than the body's own entrance.
 *
 * Both rules read the graph only, never the order the nodes sit in the file, so
 * one workflow always lays out the same way.
 */
function backEdgeIndexes(ids: readonly string[], edges: readonly LayoutInputEdge[]): Set<number> {
  const back = new Set<number>()
  const candidates: number[] = []
  edges.forEach((edge, index) => {
    if (isFallbackHandle(edge.sourceHandle)) back.add(index)
    else if (ids.includes(edge.source) && ids.includes(edge.target)) candidates.push(index)
  })
  if (candidates.length === 0) return back

  const nextOf = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const index of candidates) {
    const edge = edges[index]!
    nextOf.get(edge.source)!.push(edge.target)
  }
  const component = stronglyConnected(ids, nextOf)

  // A component's entry is the node the flow arrives from: it has an incoming
  // edge from another component. Components with no outside feed (a detached
  // retry pair) fall back to their smallest id so the answer stays stable.
  const externalEntry = new Map<number, string>()
  for (const index of candidates) {
    const edge = edges[index]!
    const targetComponent = component.get(edge.target)!
    if (component.get(edge.source) === targetComponent) continue
    const current = externalEntry.get(targetComponent)
    if (current === undefined || edge.target < current)
      externalEntry.set(targetComponent, edge.target)
  }

  // Depth inside a component, walking forward from its entry.
  const depth = new Map<string, number>()
  const members = new Map<number, string[]>()
  for (const id of [...ids].sort()) {
    const comp = component.get(id)!
    const list = members.get(comp)
    if (list) list.push(id)
    else members.set(comp, [id])
  }
  for (const [comp, nodes] of members) {
    if (nodes.length === 1 && !nextOf.get(nodes[0]!)!.includes(nodes[0]!)) {
      depth.set(nodes[0]!, 0)
      continue
    }
    const inside = new Set(nodes)
    const entry = externalEntry.get(comp) ?? nodes[0]!
    const queue = [entry]
    depth.set(entry, 0)
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!
      for (const next of nextOf.get(current) ?? []) {
        if (!inside.has(next) || depth.has(next)) continue
        depth.set(next, depth.get(current)! + 1)
        queue.push(next)
      }
    }
    for (const id of nodes) if (!depth.has(id)) depth.set(id, 0)
  }

  for (const index of candidates) {
    const edge = edges[index]!
    const sourceDepth = depth.get(edge.source) ?? 0
    const targetDepth = depth.get(edge.target) ?? 0
    // Only edges inside a cycle can point backwards; across components the
    // condensation is already a DAG.
    if (component.get(edge.source) !== component.get(edge.target)) continue
    if (targetDepth <= sourceDepth) back.add(index)
  }
  return back
}

/** Component id per node, via Kosaraju's two passes (iterative, no recursion). */
function stronglyConnected(
  ids: readonly string[],
  nextOf: Map<string, string[]>,
): Map<string, number> {
  const previousOf = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const [source, targets] of nextOf) {
    for (const target of targets) previousOf.get(target)?.push(source)
  }

  const finished: string[] = []
  const seen = new Set<string>()
  for (const root of [...ids].sort()) {
    if (seen.has(root)) continue
    const stack: { id: string; index: number }[] = [{ id: root, index: 0 }]
    seen.add(root)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const next = nextOf.get(frame.id) ?? []
      if (frame.index >= next.length) {
        finished.push(frame.id)
        stack.pop()
        continue
      }
      const target = next[frame.index++]!
      if (seen.has(target)) continue
      seen.add(target)
      stack.push({ id: target, index: 0 })
    }
  }

  const component = new Map<string, number>()
  let nextComponent = 0
  for (const root of finished.reverse()) {
    if (component.has(root)) continue
    const stack = [root]
    component.set(root, nextComponent)
    while (stack.length > 0) {
      const current = stack.pop()!
      for (const source of previousOf.get(current) ?? []) {
        if (component.has(source)) continue
        component.set(source, nextComponent)
        stack.push(source)
      }
    }
    nextComponent++
  }
  return component
}

export function autoLayout(
  nodes: readonly LayoutInputNode[],
  edges: readonly LayoutInputEdge[],
  opts: AutoLayoutOptions = {},
): Map<string, LayoutPoint> {
  const { nodeWidth, nodeHeight, hGap, vGap, maxRowWidth, rowGap } = { ...DEFAULTS, ...opts }
  const dims = new Map<string, { w: number; h: number }>()
  for (const n of nodes) {
    const w = n.measured?.width ?? n.width ?? nodeWidth
    const h = n.measured?.height ?? n.height ?? nodeHeight
    dims.set(n.id, { w, h })
  }

  // One canvas, one answer: the layout is a function of the GRAPH, not of the
  // order the nodes happen to sit in the file. That array order changes on
  // import, generation and every re-save, and sorting by id keeps the result
  // identical for the same graph. (Node ids are stable per node.)
  const ids = nodes.map((n) => n.id)
  const order = [...ids].sort()
  const backEdges = backEdgeIndexes(order, edges)
  const preds = new Map<string, Set<string>>()
  const succs = new Map<string, Set<string>>()
  ids.forEach((id) => {
    preds.set(id, new Set())
    succs.set(id, new Set())
  })
  const forwardEdges = edges.filter((_edge, index) => !backEdges.has(index))
  forwardEdges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
  for (const e of forwardEdges) {
    if (!dims.has(e.source) || !dims.has(e.target) || e.source === e.target) continue
    // A retry/fallback/loop-back edge is not an ordering constraint: counting it
    // would put the node it points at AFTER its own successors.
    succs.get(e.source)!.add(e.target)
    preds.get(e.target)!.add(e.source)
  }

  // --- Layer assignment via a topological longest-path rank ----------------
  // Kahn topological order; any nodes left over (cycle) are appended so they
  // still get a position.
  const indeg = new Map<string, number>(ids.map((id) => [id, preds.get(id)!.size]))
  const queue = order.filter((id) => (indeg.get(id) ?? 0) === 0)
  const topo: string[] = []
  const head = { i: 0 }
  while (head.i < queue.length) {
    const id = queue[head.i++]
    if (!id) break
    topo.push(id)
    for (const s of succs.get(id) ?? []) {
      const d = (indeg.get(s) ?? 0) - 1
      indeg.set(s, d)
      if (d === 0) queue.push(s)
    }
  }
  for (const id of order) if (!topo.includes(id)) topo.push(id)

  const layer = new Map<string, number>()
  ids.forEach((id) => layer.set(id, 0))
  for (const id of topo) {
    let l = 0
    for (const p of preds.get(id)!) l = Math.max(l, (layer.get(p) ?? 0) + 1)
    layer.set(id, l)
  }

  // --- Group into layers, seed order from topological order ----------------
  const layers = new Map<number, string[]>()
  for (const id of topo) {
    const l = layer.get(id) ?? 0
    if (!layers.has(l)) layers.set(l, [])
    layers.get(l)!.push(id)
  }
  const layerKeys = [...layers.keys()].sort((a, b) => a - b)

  const indexIn = (l: number, id: string): number => layers.get(l)!.indexOf(id)

  // --- Barycenter sweeps to reduce crossings -------------------------------
  const bary = (id: string, l: number, usePreds: boolean): number => {
    const neighbors = usePreds ? [...preds.get(id)!] : [...succs.get(id)!]
    const ref = neighbors
      .map((n) => {
        const nl = layer.get(n) ?? l
        return nl === l - (usePreds ? 1 : -1) ? indexIn(nl, n) : -1
      })
      .filter((i) => i >= 0)
    if (ref.length === 0) return indexIn(l, id)
    return ref.reduce((a, b) => a + b, 0) / ref.length
  }
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0
    const sweepOrder = down ? layerKeys : [...layerKeys].reverse()
    for (const l of sweepOrder) {
      const arr = layers.get(l)!
      const keys = new Map(arr.map((id) => [id, bary(id, l, down)]))
      // Ties fall back to the id so the ordering never depends on input order.
      arr.sort((a, b) => keys.get(a)! - keys.get(b)! || a.localeCompare(b))
    }
  }

  // --- Readable row packing -------------------------------------------------
  // A layer is never split: its nodes share an x column. Small graphs keep one
  // horizontal axis. Long graphs use several compact rows instead of the old
  // right-and-down staircase, which made fit-view text unreadably small.
  const layerW = (l: number): number =>
    Math.max(...layers.get(l)!.map((id) => dims.get(id)!.w), nodeWidth)
  const layerH = (l: number): number => {
    const arr = layers.get(l)!
    return arr.reduce((sum, id) => sum + dims.get(id)!.h, 0) + vGap * (arr.length - 1)
  }

  interface Row {
    layers: number[]
    /** Sum of layer widths + inter-layer gaps (no trailing gap). */
    width: number
    /** Tallest layer in the row. */
    height: number
  }

  const maxWidth = Math.max(maxRowWidth, nodeWidth + hGap)
  const unwrappedWidth = layerKeys.reduce(
    (width, layerKey, index) => width + layerW(layerKey) + (index > 0 ? hGap : 0),
    0,
  )
  // Fit-view still has to leave the 13px node title readable. The slight
  // overflow allowed here is what keeps a typical graph on one horizontal axis.
  const MIN_READABLE_OVERVIEW_ZOOM = 0.8
  const rowWidthLimit =
    unwrappedWidth <= maxWidth / MIN_READABLE_OVERVIEW_ZOOM ? unwrappedWidth : maxWidth
  const rows: Row[] = []
  let current: Row = { layers: [], width: 0, height: 0 }
  for (const l of layerKeys) {
    const lw = layerW(l)
    if (current.layers.length > 0 && current.width + hGap + lw > rowWidthLimit) {
      rows.push(current)
      current = { layers: [], width: 0, height: 0 }
    }
    current.layers.push(l)
    current.width = current.layers.length === 1 ? lw : current.width + hGap + lw
    current.height = Math.max(current.height, layerH(l))
  }
  if (current.layers.length > 0) rows.push(current)

  // --- Position assignment --------------------------------------------------
  const rowOfLayer = new Map<number, number>()
  const layerOffsets = rows.map((row, rowIndex) => {
    const offsets = new Map<number, number>()
    let x = 0
    for (const layerKey of row.layers) {
      rowOfLayer.set(layerKey, rowIndex)
      offsets.set(layerKey, x)
      x += layerW(layerKey) + hGap
    }
    return offsets
  })
  const rowStarts = rows.map(() => 0)

  // Ordinary wrap connectors turn back only into the next row. A forward jump
  // over several rows must not also shoot all the way back to the left edge:
  // shift just its destination row enough to keep that edge local/readable.
  // Rows without such a jump stay left-aligned; this is not the old staircase.
  for (let targetRow = 1; targetRow < rows.length; targetRow++) {
    for (const edge of forwardEdges) {
      if (!dims.has(edge.source) || !dims.has(edge.target)) continue
      const sourceLayer = layer.get(edge.source)!
      const targetLayer = layer.get(edge.target)!
      const sourceRow = rowOfLayer.get(sourceLayer)!
      if (rowOfLayer.get(targetLayer) !== targetRow || targetRow - sourceRow <= 1) continue
      const sourceX = rowStarts[sourceRow]! + layerOffsets[sourceRow]!.get(sourceLayer)!
      const targetOffset = layerOffsets[targetRow]!.get(targetLayer)!
      const requiredStart = sourceX + dims.get(edge.source)!.w + hGap - targetOffset
      rowStarts[targetRow] = Math.max(rowStarts[targetRow]!, requiredStart)
    }
  }

  const totalHeight = rows.reduce((sum, r) => sum + r.height, 0) + rowGap * (rows.length - 1)
  const positions = new Map<string, LayoutPoint>()
  let rowTop = -totalHeight / 2
  for (const [rowIndex, row] of rows.entries()) {
    let cursor = rowStarts[rowIndex]!
    for (const l of row.layers) {
      const arr = layers.get(l)!
      const colY = rowTop + (row.height - layerH(l)) / 2
      let y = colY
      for (const id of arr) {
        positions.set(id, { x: cursor, y })
        y += dims.get(id)!.h + vGap
      }
      cursor += layerW(l) + hGap
    }
    rowTop += row.height + rowGap
  }

  return positions
}

export interface ViewportBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ViewportSize {
  width: number
  height: number
}

export interface ViewportFit {
  x: number
  y: number
  zoom: number
}

/**
 * The viewport that centers `bounds` inside the part of the canvas the left
 * sidebar does not cover.
 *
 * `fitView` fits to the whole `.react-flow` box, but the editor's left panel is
 * an absolute overlay on top of it, so its nodes ended up hidden underneath.
 * This computes the transform for the VISIBLE rectangle: `leftInset` is the
 * overlaid width, `padding` is kept free on every side.
 */
export function viewportForBounds(
  bounds: ViewportBounds,
  size: ViewportSize,
  leftInset: number,
  padding = 48,
  zoomRange: { min: number; max: number } = { min: 0.2, max: 1.5 },
): ViewportFit {
  const availableWidth = Math.max(1, size.width - leftInset - padding * 2)
  const availableHeight = Math.max(1, size.height - padding * 2)
  const rawZoom = Math.min(
    availableWidth / Math.max(1, bounds.width),
    availableHeight / Math.max(1, bounds.height),
  )
  const zoom = Math.min(zoomRange.max, Math.max(zoomRange.min, rawZoom))
  return {
    x: leftInset + padding + (availableWidth - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: padding + (availableHeight - bounds.height * zoom) / 2 - bounds.y * zoom,
    zoom,
  }
}
