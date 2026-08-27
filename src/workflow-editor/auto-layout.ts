/**
 * One-click graph beautify — a dependency-free layered (Sugiyama-style)
 * auto-layout for the left-to-right workflow canvas.
 *
 * Steps: assign each node a layer (longest-path rank from the roots, so a node
 * sits to the right of every predecessor), order nodes within a layer by
 * barycenter sweeps to reduce edge crossings, then stack each layer vertically
 * (centered) and place layers left-to-right. Back-edges (loops) and
 * disconnected nodes are handled gracefully.
 *
 * @module workflow-editor/auto-layout
 */

export interface LayoutInputNode {
  id: string
  measured?: { width?: number; height?: number }
  width?: number
  height?: number
}
export interface LayoutInputEdge {
  source: string
  target: string
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
}

const DEFAULTS = { nodeWidth: 200, nodeHeight: 64, hGap: 70, vGap: 36 }

export function autoLayout(
  nodes: LayoutInputNode[],
  edges: LayoutInputEdge[],
  opts: AutoLayoutOptions = {},
): Map<string, LayoutPoint> {
  const { nodeWidth, nodeHeight, hGap, vGap } = { ...DEFAULTS, ...opts }
  const dims = new Map<string, { w: number; h: number }>()
  for (const n of nodes) {
    const w = n.measured?.width ?? n.width ?? nodeWidth
    const h = n.measured?.height ?? n.height ?? nodeHeight
    dims.set(n.id, { w, h })
  }

  const ids = nodes.map((n) => n.id)
  const preds = new Map<string, Set<string>>()
  const succs = new Map<string, Set<string>>()
  ids.forEach((id) => {
    preds.set(id, new Set())
    succs.set(id, new Set())
  })
  for (const e of edges) {
    if (!dims.has(e.source) || !dims.has(e.target) || e.source === e.target) continue
    succs.get(e.source)!.add(e.target)
    preds.get(e.target)!.add(e.source)
  }

  // --- Layer assignment via a topological longest-path rank ----------------
  // Kahn topological order; any nodes left over (cycle) are appended so they
  // still get a position.
  const indeg = new Map<string, number>(ids.map((id) => [id, preds.get(id)!.size]))
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0)
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
  for (const id of ids) if (!topo.includes(id)) topo.push(id)

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
    const order = down ? layerKeys : [...layerKeys].reverse()
    for (const l of order) {
      const arr = layers.get(l)!
      const keys = new Map(arr.map((id) => [id, bary(id, l, down)]))
      arr.sort((a, b) => (keys.get(a)! - keys.get(b)!))
    }
  }

  // --- Position assignment --------------------------------------------------
  const positions = new Map<string, LayoutPoint>()
  // x by cumulative max node width per layer.
  let x = 0
  const layerX = new Map<number, number>()
  for (const l of layerKeys) {
    layerX.set(l, x)
    const maxW = Math.max(...layers.get(l)!.map((id) => dims.get(id)!.w), nodeWidth)
    x += maxW + hGap
  }
  for (const l of layerKeys) {
    const arr = layers.get(l)!
    const totalH = arr.reduce((sum, id) => sum + dims.get(id)!.h, 0) + vGap * (arr.length - 1)
    let y = -totalH / 2
    for (const id of arr) {
      positions.set(id, { x: layerX.get(l)!, y })
      y += dims.get(id)!.h + vGap
    }
  }

  return positions
}
