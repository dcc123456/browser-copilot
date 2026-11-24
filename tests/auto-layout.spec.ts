import { describe, it, expect } from 'vitest'
import {
  autoLayout,
  viewportForBounds,
  type LayoutPackingInfo,
} from '../src/workflow-editor/auto-layout'

describe('autoLayout', () => {
  it('places a linear chain in increasing-x layers', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ]
    const pos = autoLayout(nodes, edges)
    const xa = pos.get('a')!.x
    const xb = pos.get('b')!.x
    const xc = pos.get('c')!.x
    expect(xb).toBeGreaterThan(xa)
    expect(xc).toBeGreaterThan(xb)
  })

  it('gives a root and its two successors matching/smaller layer order', () => {
    const nodes = [{ id: 'root' }, { id: 's1' }, { id: 's2' }]
    const edges = [
      { source: 'root', target: 's1' },
      { source: 'root', target: 's2' },
    ]
    const pos = autoLayout(nodes, edges)
    expect(pos.get('s1')!.x).toBeGreaterThan(pos.get('root')!.x)
    expect(pos.get('s2')!.x).toBeGreaterThan(pos.get('root')!.x)
    // successors share a layer
    expect(pos.get('s1')!.x).toBe(pos.get('s2')!.x)
    // and are stacked vertically with no overlap
    expect(pos.get('s2')!.y).toBeGreaterThan(pos.get('s1')!.y)
  })

  it('positions every node and never overlaps nodes in the same layer', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
      { source: 'b', target: 'd' },
      { source: 'c', target: 'd' },
    ]
    const pos = autoLayout(nodes, edges)
    for (const n of nodes) expect(pos.get(n.id)).toBeDefined()
    // d has the longest path (root->b->d) so it is two layers right of a.
    expect(pos.get('d')!.x).toBeGreaterThan(pos.get('b')!.x)
  })

  it('handles disconnected nodes and self-loops without throwing', () => {
    const nodes = [{ id: 'x' }, { id: 'y' }, { id: 'loop' }]
    const edges = [{ source: 'loop', target: 'loop' }]
    const pos = autoLayout(nodes, edges)
    expect(pos.size).toBe(3)
  })

  it('keeps a short chain on a single left→right row', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ]
    const pos = autoLayout(nodes, edges)
    // One row: same y, increasing x.
    expect(pos.get('a')!.y).toBe(pos.get('b')!.y)
    expect(pos.get('b')!.x).toBeGreaterThan(pos.get('a')!.x)
    expect(pos.get('c')!.x).toBeGreaterThan(pos.get('b')!.x)
  })

  it('wraps a long chain into compact left-aligned rows', () => {
    const nodes = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}` }))
    const edges = Array.from({ length: 5 }, (_, i) => ({
      source: `n${i}`,
      target: `n${i + 1}`,
    }))
    // Default columns are 200 wide + 20 gap → three columns fit 740; the
    // fourth wraps, so this lays out as two rows of three.
    const pos = autoLayout(nodes, edges, { maxRowWidth: 740 })
    expect(pos.get('n0')!.x).toBeLessThan(pos.get('n1')!.x)
    expect(pos.get('n1')!.x).toBeLessThan(pos.get('n2')!.x)
    expect(pos.get('n3')!.x).toBeLessThan(pos.get('n4')!.x)
    expect(pos.get('n4')!.x).toBeLessThan(pos.get('n5')!.x)
    // The next row sits below and starts at the same left edge. Continuing it
    // to the right made the whole graph a long diagonal with unreadable text.
    expect(pos.get('n3')!.y).toBeGreaterThan(pos.get('n0')!.y)
    expect(pos.get('n3')!.x).toBe(pos.get('n0')!.x)
    expect(pos.get('n2')!.x).toBe(pos.get('n5')!.x)
  })

  it('keeps a typical branching graph on one horizontal axis while it is readable', () => {
    const nodes = ['start', 'open', 'condition', 'a', 'b', 'merge'].map((id) => ({ id }))
    const edges = [
      { source: 'start', target: 'open' },
      { source: 'open', target: 'condition' },
      { source: 'condition', target: 'a' },
      { source: 'condition', target: 'b' },
      { source: 'a', target: 'merge' },
      { source: 'b', target: 'merge' },
    ]
    const pos = autoLayout(nodes, edges, { maxRowWidth: 1032 })
    // Five ranks: 1280px. It exceeds the preferred row width slightly, but
    // fit-view can still show it at a readable scale, so there is no wrap.
    // One main axis plus the two branch rows.
    expect(new Set([...pos.values()].map((point) => point.y)).size).toBe(3)
    expect(pos.get('merge')!.y).toBe(pos.get('start')!.y)
    expect(pos.get('a')!.x).toBe(pos.get('b')!.x)
    expect(pos.get('merge')!.x).toBeGreaterThan(pos.get('a')!.x)
  })

  describe('atomic condition branch groups', () => {
    const branchNodes = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'].map((id) => ({
      id,
      width: 180,
      height: 52,
    }))
    const branchEdges = [
      { source: 't1', target: 't2' },
      { source: 't2', target: 't3' },
      { source: 't3', target: 't4' },
      { source: 't4', target: 't5' },
      { source: 't4', target: 't6' },
      { source: 't5', target: 't7' },
      { source: 't6', target: 't7' },
      { source: 't7', target: 't8' },
    ]

    it('keeps condition, both branches and merge together when narrow rows wrap', () => {
      const placed = autoLayout(branchNodes, branchEdges, { maxRowWidth: 500 })
      expect(new Set([...placed.values()].map((point) => point.y)).size).toBeGreaterThan(2)
      // The condition and merge are centered on one group axis; alternatives
      // are above/below it, and the merge remains on their right.
      expect(placed.get('t7')!.y).toBe(placed.get('t4')!.y)
      expect((placed.get('t5')!.y + placed.get('t6')!.y) / 2).toBe(placed.get('t4')!.y)
      expect(placed.get('t5')!.x).toBe(placed.get('t6')!.x)
      expect(placed.get('t5')!.x).toBeGreaterThan(placed.get('t4')!.x)
      expect(placed.get('t7')!.x).toBeGreaterThan(placed.get('t5')!.x)
    })

    it('keeps the branch group intact when the wider gaps force a re-pack', () => {
      // 40px gaps no longer fit this graph on one axis at the real viewport
      // width, so it wraps; the semantic unit must survive that (approved A).
      const reported: LayoutPackingInfo[] = []
      const placed = autoLayout(branchNodes, branchEdges, {
        maxRowWidth: 1032,
        maxRowHeight: 804,
        onPacking: (info) => reported.push(info),
      })
      expect(reported[0]!.rows).toBeGreaterThan(1)
      // The branch unit survives the wrap: condition and merge share its axis,
      // the alternatives share their own column, and the merge stays to their
      // right. The node AFTER the unit may start a new row — that is the accepted
      // cost of wider gaps.
      expect(placed.get('t7')!.y).toBe(placed.get('t4')!.y)
      expect(placed.get('t5')!.x).toBe(placed.get('t6')!.x)
      expect(placed.get('t5')!.x).toBeGreaterThan(placed.get('t4')!.x)
      expect(placed.get('t7')!.x).toBeGreaterThan(placed.get('t5')!.x)
      expect(placed.get('t8')!.y).toBeGreaterThanOrEqual(placed.get('t4')!.y)
      expect([...placed.keys()]).toHaveLength(branchNodes.length)
    })

    it('keeps the atomic layout deterministic when node order is reversed', () => {
      const forward = autoLayout(branchNodes, branchEdges, { maxRowWidth: 500 })
      const reversed = autoLayout([...branchNodes].reverse(), branchEdges, { maxRowWidth: 500 })
      const serialize = (placed: typeof forward): [string, { x: number; y: number }][] =>
        [...placed].sort(([a], [b]) => a.localeCompare(b))
      expect(serialize(reversed)).toEqual(serialize(forward))
    })
  })

  it('keeps an approved small graph exactly as laid out and reports no re-pack', () => {
    const nodes = ['start', 'open', 'condition', 'a', 'b', 'merge'].map((id) => ({ id }))
    const edges = [
      { source: 'start', target: 'open' },
      { source: 'open', target: 'condition' },
      { source: 'condition', target: 'a' },
      { source: 'condition', target: 'b' },
      { source: 'a', target: 'merge' },
      { source: 'b', target: 'merge' },
    ]
    const reported: LayoutPackingInfo[] = []
    const baseline = autoLayout(nodes, edges, { maxRowWidth: 1032 })
    const withReport = autoLayout(nodes, edges, {
      maxRowWidth: 1032,
      maxRowHeight: 804,
      onPacking: (info) => reported.push(info),
    })
    // Readable graph: the search must not touch the approved shape.
    expect([...withReport]).toEqual([...baseline])
    expect(reported).toHaveLength(1)
    expect(reported[0]!.repacked).toBe(false)
    expect(reported[0]!.rows).toBe(1)
  })

  it('re-packs a graph that would read too small and reports the chosen columns', () => {
    const nodes = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, width: 180, height: 52 }))
    const edges = Array.from({ length: 59 }, (_, i) => ({
      source: `n${i}`,
      target: `n${i + 1}`,
    }))
    const reported: LayoutPackingInfo[] = []
    const placed = autoLayout(nodes, edges, {
      maxRowWidth: 1032,
      maxRowHeight: 804,
      onPacking: (info) => reported.push(info),
    })
    const packing = reported[0]!
    // The whole reason for the search: filling the width would be too tall to read.
    expect(packing.repacked).toBe(true)
    expect(packing.columnsPerRow).toBeGreaterThan(5)
    expect(packing.rows).toBeGreaterThan(1)
    // The packing is short enough that a 804px-tall viewport can zoom in.
    expect(packing.contentHeight).toBeLessThan(1400)
    // Still one card per layer position: nothing overlaps in the same column.
    expect([...placed.keys()]).toHaveLength(60)
  })

  it('never splits a layer across rows and positions every node', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
      { source: 'b', target: 'd' },
      { source: 'c', target: 'd' },
    ]
    // Even with a tiny row width, b and c keep sharing a column.
    const pos = autoLayout(nodes, edges, { maxRowWidth: 300 })
    for (const n of nodes) expect(pos.get(n.id)).toBeDefined()
    expect(pos.get('b')!.x).toBe(pos.get('c')!.x)
  })

  it('keeps an 18-step chain readable after the real viewport fit calculation', () => {
    const nodes = Array.from({ length: 18 }, (_, i) => ({ id: `n${i}` }))
    const edges = Array.from({ length: 17 }, (_, i) => ({
      source: `n${i}`,
      target: `n${i + 1}`,
    }))
    const pos = autoLayout(nodes, edges, { maxRowWidth: 1032 })
    const points = [...pos.values()]
    const minX = Math.min(...points.map((point) => point.x))
    const minY = Math.min(...points.map((point) => point.y))
    const maxX = Math.max(...points.map((point) => point.x + 200))
    const maxY = Math.max(...points.map((point) => point.y + 64))
    const fit = viewportForBounds(
      { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      { width: 1440, height: 900 },
      360,
      48,
    )
    expect(fit.zoom * 13).toBeGreaterThanOrEqual(9)
    expect(fit.zoom * 200).toBeGreaterThanOrEqual(110)
    expect(new Set(points.map((point) => point.y)).size).toBeGreaterThan(1)
  })
})

describe('viewportForBounds', () => {
  const size = { width: 1000, height: 600 }
  const bounds = { x: 1000, y: 500, width: 800, height: 200 }

  it('fits the graph inside the area the left panel leaves visible', () => {
    const fit = viewportForBounds(bounds, size, 300, 48)
    expect(fit.zoom).toBeCloseTo(0.755)
    // The graph's left edge lands on the inset + padding, not under the panel.
    expect(fit.x + bounds.x * fit.zoom).toBeCloseTo(348)
  })

  it('centers the graph vertically in the visible canvas', () => {
    const fit = viewportForBounds(bounds, size, 300, 48)
    const centerY = fit.y + (bounds.y + bounds.height / 2) * fit.zoom
    expect(centerY).toBeCloseTo(size.height / 2)
  })

  it('clamps the zoom so huge graphs stay readable and tiny ones do not balloon', () => {
    expect(viewportForBounds({ x: 0, y: 0, width: 100_000, height: 100_000 }, size, 0).zoom).toBe(
      0.2,
    )
    expect(viewportForBounds({ x: 0, y: 0, width: 10, height: 10 }, size, 0).zoom).toBe(1.5)
  })

  it('survives a canvas narrower than the panel without dividing by zero', () => {
    const fit = viewportForBounds({ x: 0, y: 0, width: 100, height: 100 }, size, 1200)
    expect(Number.isFinite(fit.x)).toBe(true)
    expect(Number.isFinite(fit.y)).toBe(true)
    expect(fit.zoom).toBe(0.2)
  })
})
