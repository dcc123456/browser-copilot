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
})
