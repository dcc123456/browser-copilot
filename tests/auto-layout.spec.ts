import { describe, it, expect } from 'vitest'
import { autoLayout } from '../src/workflow-editor/auto-layout'

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

  it('wraps a long chain into Z-shaped rows (every row reads left→right)', () => {
    const nodes = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}` }))
    const edges = Array.from({ length: 5 }, (_, i) => ({
      source: `n${i}`,
      target: `n${i + 1}`,
    }))
    // Default columns are 200 wide + 70 gap → three columns fill 740; the
    // fourth wraps, so this lays out as two rows of three.
    const pos = autoLayout(nodes, edges, { maxRowWidth: 740 })
    // Row 0: n0 → n2 left→right.
    expect(pos.get('n0')!.x).toBeLessThan(pos.get('n1')!.x)
    expect(pos.get('n1')!.x).toBeLessThan(pos.get('n2')!.x)
    // Row 1 also reads left→right (Z-shape, not serpentine).
    expect(pos.get('n3')!.x).toBeLessThan(pos.get('n4')!.x)
    expect(pos.get('n4')!.x).toBeLessThan(pos.get('n5')!.x)
    // Row 1 sits below row 0 and starts at the same left edge; the connector
    // from n2 back to n3 draws the Z's return stroke.
    expect(pos.get('n3')!.y).toBeGreaterThan(pos.get('n0')!.y)
    expect(pos.get('n3')!.x).toBe(pos.get('n0')!.x)
    expect(pos.get('n2')!.x).toBe(pos.get('n5')!.x)
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
})
