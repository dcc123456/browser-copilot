/**
 * One-click graph beautify — a dependency-free layered (Sugiyama-style)
 * auto-layout for the workflow canvas.
 *
 * Each rank is a vertical column and ranks advance left→right. A condition,
 * its alternative paths and their nearest common merge form an ATOMIC branch
 * group. Typical graphs stay on one horizontal axis; a graph too wide to read
 * is split only between complete groups so a merge can never fall behind its
 * branches. Long chains use compact, left-aligned rows to keep fit-view text
 * readable.
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

/** Which spacing the layout settled on: wide gaps, or the compact fallback. */
export type LayoutGapMode = 'wide' | 'compact'

/** What the packing search settled on (see `onPacking`). */
export interface LayoutPackingInfo {
  /** Columns per row in the chosen packing. */
  columnsPerRow: number
  /** Rows the graph was split into. */
  rows: number
  /** Bounding box of the chosen packing, in canvas units. */
  contentWidth: number
  contentHeight: number
  /**
   * True when the approved "fill the width" packing was replaced because it read
   * below the legibility floor. A false value means the graph kept its usual shape.
   */
  repacked: boolean
  /** Which card spacing was used; a fallback means the wide gaps read too small. */
  gapMode: LayoutGapMode
  /**
   * Columns in each row, top to bottom. A row of one or two columns is the
   * fragment the layout refuses to create, so QA can check the shape directly.
   */
  rowsColumns: number[]
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
  /** Visible viewport height; the packing search uses it to estimate fit zoom. */
  maxRowHeight?: number
  /**
   * Reports the packing that was actually used. The chosen column count is a
   * layout decision, so it must be observable: otherwise nobody can tell a
   * strategy change from a lucky fit.
   */
  onPacking?: (info: LayoutPackingInfo) => void
}

const DEFAULTS = {
  nodeWidth: 200,
  nodeHeight: 64,
  /**
   * Gaps are in CANVAS units, while what the user sees is gap × fit zoom. 40 was
   * chosen so the on-screen gap clears 28px on the graphs people complained
   * about; the earlier 20 (a regression from 70 when atomic branch groups landed)
   * showed up as 14px on the typical graph and read as "the cards are cramped".
   * Raising it trades against the fit zoom: a wider graph zooms out, so the
   * readable node count drops — that tradeoff is recorded in the layout spec.
   */
  hGap: 40,
  vGap: 40,
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
  const { nodeWidth, nodeHeight, hGap, vGap, maxRowWidth, rowGap, maxRowHeight, onPacking } = {
    ...DEFAULTS,
    ...opts,
  }
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

  // --- Atomic branch groups -------------------------------------------------
  // A condition, its alternative paths and their nearest common merge form one
  // layout unit. A row break may happen BEFORE or AFTER this unit, never inside
  // it: splitting the paths from their merge is what made the main chain look
  // upside-down in the previous layout.
  const reachableFrom = (root: string): Set<string> => {
    const reached = new Set<string>([root])
    const queue = [root]
    for (let head = 0; head < queue.length; head++) {
      for (const next of succs.get(queue[head]!) ?? []) {
        if (reached.has(next)) continue
        reached.add(next)
        queue.push(next)
      }
    }
    return reached
  }
  interface LayerRange {
    startIndex: number
    endIndex: number
  }
  const branchRanges: LayerRange[] = []
  for (const [layerKey, layerNodes] of layers) {
    for (const id of layerNodes) {
      const branches = [...succs.get(id)!].sort()
      if (branches.length < 2) continue
      const reachable = branches.map(reachableFrom)
      const shared = [...reachable[0]!]
        .filter((candidate) => reachable.every((paths) => paths.has(candidate)))
        .sort((a, b) => layer.get(a)! - layer.get(b)! || a.localeCompare(b))
      const endLayer = shared[0]
        ? layer.get(shared[0])!
        : Math.max(...reachable.flatMap((paths) => [...paths].map((path) => layer.get(path)!)))
      branchRanges.push({
        startIndex: layerKeys.indexOf(layerKey),
        endIndex: layerKeys.indexOf(endLayer),
      })
    }
  }
  branchRanges.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex)
  const atomicRanges: LayerRange[] = []
  for (const range of branchRanges) {
    const previous = atomicRanges[atomicRanges.length - 1]
    if (previous && range.startIndex <= previous.endIndex) {
      previous.endIndex = Math.max(previous.endIndex, range.endIndex)
    } else {
      atomicRanges.push({ ...range })
    }
  }

  /**
   * Compact fallback used only when the wide gaps push the text below the
   * legibility floor. This is the spacing the editor used before, kept so a big
   * graph can never read WORSE than it did then.
   */
  const COMPACT_GAP = { hGap: 20, vGap: 36 }
  const READABLE_TARGET_ZOOM = 0.7
  /**
   * A row of one or two columns is a fragment: it reads as a detour (the main
   * chain visibly folds backwards) instead of a flow. Rows keep at least three
   * columns and are left-aligned, so the graph resumes at the left edge.
   */
  const MIN_ROW_COLUMNS_PER_ROW = 3

  // `dims` already contains the fallback for an unmeasured node. Applying
  // nodeWidth again as a minimum here widened every measured 180px card to a
  // 200px column and pushed an otherwise readable graph below the font floor.
  const layerW = (l: number): number => Math.max(...layers.get(l)!.map((id) => dims.get(id)!.w))

  interface LayoutUnit extends LayerRange {
    width: number
    height: number
  }
  interface Row {
    units: LayoutUnit[]
    width: number
    height: number
  }
  interface BuiltLayout {
    positions: Map<string, LayoutPoint>
    packing: LayoutPackingInfo
    /** Internal fit-zoom estimate, used only to choose between gaps. */
    zoom: number
  }

  const buildLayout = (
    gapX: number,
    gapY: number,
    gapMode: LayoutGapMode,
    keepRowsWhole: boolean,
  ): BuiltLayout => {
    const layerH = (l: number): number => {
      const arr = layers.get(l)!
      return arr.reduce((sum, id) => sum + dims.get(id)!.h, 0) + gapY * (arr.length - 1)
    }
    const units: LayoutUnit[] = []
    for (let index = 0; index < layerKeys.length;) {
      const range = atomicRanges.find((candidate) => candidate.startIndex === index)
      const endIndex = range?.endIndex ?? index
      const unitLayers = layerKeys.slice(index, endIndex + 1)
      units.push({
        startIndex: index,
        endIndex,
        width:
          unitLayers.reduce((sum, key) => sum + layerW(key), 0) + gapX * (unitLayers.length - 1),
        height: Math.max(...unitLayers.map(layerH)),
      })
      index = endIndex + 1
    }

    const maxWidth = Math.max(maxRowWidth, nodeWidth + gapX)
    const columnsOfRow = (row: Row): number =>
      row.units.reduce((span, unit) => span + unit.endIndex - unit.startIndex + 1, 0)
    /** Merge two rows, keeping the earlier row's units first (reading order). */
    const mergeRows = (first: Row, second: Row): Row => ({
      units: [...first.units, ...second.units],
      width: first.width + gapX + second.width,
      height: Math.max(first.height, second.height),
    })
    const packRows = (rowWidthLimit: number, keepRowsWhole: boolean): Row[] => {
      const packed: Row[] = []
      let current: Row = { units: [], width: 0, height: 0 }
      for (const unit of units) {
        if (current.units.length > 0 && current.width + gapX + unit.width > rowWidthLimit) {
          packed.push(current)
          current = { units: [], width: 0, height: 0 }
        }
        current.units.push(unit)
        current.width = current.units.length === 1 ? unit.width : current.width + gapX + unit.width
        current.height = Math.max(current.height, unit.height)
      }
      if (current.units.length > 0) packed.push(current)
      if (!keepRowsWhole) return packed
      // A row holding one or two columns is a fragment: it reads as a staircase
      // detour rather than a flow, and the main chain visibly folds backwards.
      // Such a row is absorbed by its neighbour instead; rows stay left-aligned,
      // so the graph grows rightward within a row and resumes at the left edge.
      // Repeat until no fragment is left: merging a short row can leave the row
      // it merged into still short, so a single pass over the array is not enough.
      for (let changed = true; changed;) {
        changed = false
        for (let index = packed.length - 1; index >= 0; index--) {
          if (packed.length < 2 || columnsOfRow(packed[index]!) >= MIN_ROW_COLUMNS_PER_ROW) {
            continue
          }
          if (index === 0) {
            packed[0] = mergeRows(packed[0]!, packed[1]!)
            packed.splice(1, 1)
          } else {
            packed[index - 1] = mergeRows(packed[index - 1]!, packed[index]!)
            packed.splice(index, 1)
          }
          changed = true
          break
        }
      }
      return packed
    }
    const fitZoomOf = (packed: Row[]): number => {
      const width = Math.max(...packed.map((row) => row.width))
      const height = packed.reduce((sum, row) => sum + row.height, 0) + rowGap * (packed.length - 1)
      return Math.min(
        maxRowWidth / Math.max(1, width),
        (maxRowHeight ?? maxRowWidth) / Math.max(1, height),
      )
    }

    const MIN_READABLE_OVERVIEW_ZOOM = 0.65
    const unwrappedWidth = units.reduce(
      (width, unit, index) => width + unit.width + (index > 0 ? gapX : 0),
      0,
    )
    const baselineLimit =
      unwrappedWidth <= maxWidth / MIN_READABLE_OVERVIEW_ZOOM ? unwrappedWidth : maxWidth
    let rows = packRows(baselineLimit, keepRowsWhole)

    // A fit zoom below this reads as unreadable for the 13px node title: 13 × 0.7
    // ≈ 9.1px, the legibility floor. 0.75 was rejected because it would re-pack
    // graphs that are already comfortable (the approved 8-node graph sits at 0.71)
    // and change shapes nobody complained about.
    let repacked = false
    if (fitZoomOf(rows) < READABLE_TARGET_ZOOM) {
      // "Fill the width, then wrap" is not the same as "biggest readable
      // overview": a 50-node graph filled to every column grows so tall that
      // fit-view shrinks the text below legibility. Try every achievable column
      // count — a branch unit spans several columns and is never split, so the
      // search starts at its span.
      const widestUnitColumns = Math.max(
        ...units.map((unit) => unit.endIndex - unit.startIndex + 1),
      )
      let bestZoom = fitZoomOf(rows)
      for (let columns = widestUnitColumns; columns <= layerKeys.length; columns++) {
        const packed = packRows(columns * (nodeWidth + gapX), keepRowsWhole)
        const zoom = fitZoomOf(packed)
        if (zoom > bestZoom + 1e-6) {
          bestZoom = zoom
          rows = packed
          repacked = true
        }
      }
    }

    // Units stay intact. Inside a branch unit the condition is on the left, its
    // alternatives share the next column, and the merge remains to their right.
    const totalHeight = rows.reduce((sum, row) => sum + row.height, 0) + rowGap * (rows.length - 1)
    const positions = new Map<string, LayoutPoint>()
    let rowTop = -totalHeight / 2
    for (const row of rows) {
      let cursor = 0
      for (const unit of row.units) {
        for (let index = unit.startIndex; index <= unit.endIndex; index++) {
          const layerKey = layerKeys[index]!
          const column = layers.get(layerKey)!
          const colY = rowTop + (row.height - layerH(layerKey)) / 2
          let y = colY
          for (const id of column) {
            positions.set(id, { x: cursor, y })
            y += dims.get(id)!.h + gapY
          }
          cursor += layerW(layerKey) + gapX
        }
      }
      rowTop += row.height + rowGap
    }

    return {
      positions,
      zoom: fitZoomOf(rows),
      packing: {
        columnsPerRow: Math.max(
          ...rows.map((row) =>
            row.units.reduce((span, unit) => span + unit.endIndex - unit.startIndex + 1, 0),
          ),
        ),
        rowsColumns: rows.map((row) =>
          row.units.reduce((span, unit) => span + unit.endIndex - unit.startIndex + 1, 0),
        ),
        rows: rows.length,
        contentWidth: Math.round(Math.max(...rows.map((row) => row.width))),
        contentHeight: Math.round(
          rows.reduce((sum, row) => sum + row.height, 0) + rowGap * (rows.length - 1),
        ),
        repacked,
        gapMode,
      },
    }
  }

  // DEFAULTS.hGap / vGap are the wide spacing; the on-screen gap is that times
  // the fit zoom, which is why a smaller zoom needs a larger logical gap.
  // Four combinations are considered: wide/compact gaps, each with row fragments
  // forbidden or allowed. Wide gaps without fragments is the preferred shape —
  // roomy cards that never fold the main chain back into a 1-2 column detour.
  // When that cannot stay readable, the readable candidate with the largest zoom
  // wins; the compact + fragments case is exactly the previous behaviour, so no
  // graph can end up worse than before.
  // Shape first: a row holding one or two columns reads as a detour, so rows are
  // never allowed to fragment. Between the two gap tiers the readable one wins;
  // when neither is readable the compact tier is kept (smaller gaps, same shape)
  // and the caller can read the measured facts from onPacking.
  const wide = buildLayout(hGap, vGap, 'wide', true)
  let chosen = wide
  if (wide.zoom < READABLE_TARGET_ZOOM) {
    const compact = buildLayout(COMPACT_GAP.hGap, COMPACT_GAP.vGap, 'compact', true)
    if (compact.zoom > wide.zoom + 1e-6) chosen = compact
  }
  onPacking?.(chosen.packing)

  return chosen.positions
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
