/**
 * One-click graph beautify — a dependency-free layered (Sugiyama-style)
 * auto-layout for the workflow canvas with Z-shaped row wrapping.
 *
 * Steps: assign each node a layer (longest-path rank from the roots, so a node
 * sits to the right of every predecessor), order nodes within a layer by
 * barycenter sweeps to reduce edge crossings, then pack whole layers into rows
 * no wider than `maxRowWidth` (the editor passes the live canvas width).
 *
 * Rows read like lines of text: every row flows left→right, and when one row
 * can't fit the remaining layers the layout wraps to the next row below — the
 * connector from a row's last node back to the next row's first node draws the
 * "Z" through the inter-row gap. After the editor's fit-view the whole graph
 * stays inside the viewport at a readable zoom.
 *
 * Because rows never reverse, nodes keep the standard orientation (input on
 * the left, outputs on the right). Edges that would close a cycle — a fallback
 * that retries an earlier block, a loop that runs back to its head — are
 * EXCLUDED from layer assignment; treating them as "next layer" makes the rank
 * order meaningless and drops nodes to the left of their own predecessors.
 * Disconnected nodes are handled gracefully.
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
  /** Maximum width of one Z-row before the layout wraps (px). */
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

  // --- Stepped row packing --------------------------------------------------
  // Pack whole layers into rows no wider than `maxRowWidth` (a layer is never
  // split — its nodes share an x column). When a row fills up, the next layers
  // continue on the row below, STARTING TO THE RIGHT of the row just filled.
  // Wrapping used to restart each row at x=0, which drew the first connector of
  // a new row backwards (Z shape): users read a leftward edge as "I wired it
  // wrong". The graph now grows rightward the whole way — wider canvas, no
  // backwards arrows.
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
  const rows: Row[] = []
  let current: Row = { layers: [], width: 0, height: 0 }
  for (const l of layerKeys) {
    const lw = layerW(l)
    if (current.layers.length > 0 && current.width + hGap + lw > maxWidth) {
      rows.push(current)
      current = { layers: [], width: 0, height: 0 }
    }
    current.layers.push(l)
    current.width = current.layers.length === 1 ? lw : current.width + hGap + lw
    current.height = Math.max(current.height, layerH(l))
  }
  if (current.layers.length > 0) rows.push(current)

  // --- Position assignment --------------------------------------------------
  // Rows stack top→bottom with `rowGap` between them, and each row continues
  // where the previous one ended: x only ever grows, so every forward edge
  // points right. Nodes keep the standard left-input / right-output orientation.
  const totalHeight = rows.reduce((sum, r) => sum + r.height, 0) + rowGap * (rows.length - 1)

  const positions = new Map<string, LayoutPoint>()
  // Center the whole block on the canvas origin (fit-view re-centers anyway).
  let rowTop = -totalHeight / 2
  let rowStartX = 0
  for (const row of rows) {
    let cursor = rowStartX
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
    // `cursor` already carries the trailing gap; the next row starts there.
    rowStartX = cursor
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
