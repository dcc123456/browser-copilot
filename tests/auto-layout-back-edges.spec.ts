import { describe, expect, it } from 'vitest'
import {
  autoLayout,
  type LayoutInputEdge,
  type LayoutPoint,
} from '../src/workflow-editor/auto-layout'

/**
 * One-click beautify used to treat EVERY edge as "next layer", so an onError
 * fallback that retries an earlier block (or a loop returning to its head) made
 * the graph cyclic. The cycle's nodes then fell out of the topological order and
 * were re-appended in array order, which pushed an earlier block to the RIGHT of
 * its own successors — the "排版后线全乱了" report. A back edge is a retry, not
 * an ordering constraint.
 */

const WIDTH = 200
const HEIGHT = 64
const H_GAP = 20
const V_GAP = 36

/** trigger → conditions → (click → extract | js) → save, and extract retries conditions. */
const FORWARD: LayoutInputEdge[] = [
  { source: 't', target: 'cond' },
  { source: 'cond', target: 'click' },
  { source: 'cond', target: 'js' },
  { source: 'click', target: 'extract' },
  { source: 'js', target: 'save' },
  { source: 'extract', target: 'save' },
]
// The retry leaves the onError fallback port — that is what makes it a back
// edge without guessing from the array order.
const FALLBACK: LayoutInputEdge = {
  source: 'extract',
  target: 'cond',
  sourceHandle: 'extract-output-fallback',
}
const IDS = ['t', 'cond', 'click', 'extract', 'js', 'save']

function layout(
  ids: readonly string[],
  edges: readonly LayoutInputEdge[],
): Map<string, LayoutPoint> {
  return autoLayout(
    ids.map((id) => ({ id })),
    edges,
    { maxRowWidth: 5000 },
  )
}

function positions(map: Map<string, LayoutPoint>): Record<string, string> {
  return Object.fromEntries([...map].map(([id, p]) => [id, `${p.x},${p.y}`]))
}

describe('auto-layout with a fallback (back) edge', () => {
  it('does not let the retry edge change where anything is placed', () => {
    expect(positions(layout(IDS, [...FORWARD, FALLBACK]))).toEqual(positions(layout(IDS, FORWARD)))
  })

  it('places a block left of everything it feeds, whatever order the nodes are stored in', () => {
    const orders = [
      IDS,
      ['t', 'cond', 'js', 'save', 'click', 'extract'],
      ['t', 'js', 'save', 'click', 'extract', 'cond'],
      ['save', 'extract', 'click', 'cond', 'js', 't'],
    ]
    for (const order of orders) {
      const placed = layout(order, [...FORWARD, FALLBACK])
      expect(positions(placed)).toEqual(positions(layout(IDS, FORWARD)))
      for (const edge of FORWARD) {
        expect(placed.get(edge.source)!.x).toBeLessThan(placed.get(edge.target)!.x)
      }
    }
  })

  it('keeps cards apart: no overlap, and the row/column gaps stay at least the configured ones', () => {
    const placed = layout(IDS, [...FORWARD, FALLBACK])
    const entries = [...placed]
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [aId, a] = entries[i]!
        const [bId, b] = entries[j]!
        const apartX = Math.abs(a.x - b.x) >= WIDTH + H_GAP - 1e-6
        const apartY = Math.abs(a.y - b.y) >= HEIGHT + V_GAP - 1e-6
        expect(apartX || apartY, `${aId} overlaps ${bId}`).toBe(true)
      }
    }
  })
})

describe('a hand-drawn retry line (no fallback handle at all)', () => {
  // What the user actually draws: the retry leaves the same `output-1` handle a
  // normal edge does. Only the graph shape can tell it apart, so the exclusion
  // must come from the cycle, not from the handle.
  const handDrawn: LayoutInputEdge = { source: 'extract', target: 'cond' }

  it('is excluded from layering just like an onError fallback', () => {
    expect(positions(layout(IDS, [...FORWARD, handDrawn]))).toEqual(positions(layout(IDS, FORWARD)))
  })

  it('does not change with the node array order', () => {
    const reference = JSON.stringify([...layout(IDS, [...FORWARD, handDrawn])])
    expect(JSON.stringify([...layout([...IDS].reverse(), [...FORWARD, handDrawn])])).toBe(reference)
  })
})

describe('auto-layout with a loop body', () => {
  // while-loop --loop--> body1 -> body2 -> breakpoint -> (back to the loop head)
  const edges: LayoutInputEdge[] = [
    { source: 'start', target: 'loop' },
    { source: 'loop', target: 'body1' },
    { source: 'body1', target: 'body2' },
    { source: 'body2', target: 'bp' },
    { source: 'bp', target: 'loop' },
    { source: 'bp', target: 'after' },
  ]

  it('lays the body out left→right and keeps the breakpoint on the body exit side', () => {
    const placed = layout(['start', 'loop', 'body1', 'body2', 'bp', 'after'], edges)
    expect(placed.get('start')!.x).toBeLessThan(placed.get('loop')!.x)
    expect(placed.get('loop')!.x).toBeLessThan(placed.get('body1')!.x)
    expect(placed.get('body1')!.x).toBeLessThan(placed.get('body2')!.x)
    expect(placed.get('body2')!.x).toBeLessThan(placed.get('bp')!.x)
    expect(placed.get('bp')!.x).toBeLessThan(placed.get('after')!.x)
  })
})

describe('auto-layout edge cases', () => {
  it('ignores a self-loop instead of ranking the node against itself', () => {
    const placed = layout(
      ['a', 'b'],
      [
        { source: 'a', target: 'a' },
        { source: 'a', target: 'b' },
      ],
    )
    expect(placed.get('a')!.x).toBeLessThan(placed.get('b')!.x)
    expect(new Set([...placed.values()].map((p) => p.y)).size).toBe(1)
  })

  it('still places nodes that only have back edges', () => {
    // Nothing is reachable from the "root" side here: every edge points back.
    const placed = layout(
      ['a', 'b'],
      [
        { source: 'b', target: 'a' },
        { source: 'a', target: 'b' },
      ],
    )
    expect(placed.size).toBe(2)
  })
})

/** Forward edges that turn back because their target is on a wrapped row. */
function backwardForwardEdges(
  placed: Map<string, LayoutPoint>,
  edges: readonly LayoutInputEdge[],
  excluded: readonly LayoutInputEdge[],
): string[] {
  const skip = new Set(excluded.map((e) => `${e.source}->${e.target}`))
  return edges
    .filter((e) => !skip.has(`${e.source}->${e.target}`))
    .filter((e) => placed.get(e.target)!.x <= placed.get(e.source)!.x)
    .map((e) => `${e.source}->${e.target}`)
}

function overlappingPairs(
  placed: Map<string, LayoutPoint>,
  size = { w: WIDTH, h: HEIGHT },
): string[] {
  const entries = [...placed]
  const pairs: string[] = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [aId, a] = entries[i]!
      const [bId, b] = entries[j]!
      if (Math.abs(a.x - b.x) < size.w && Math.abs(a.y - b.y) < size.h) pairs.push(`${aId}|${bId}`)
    }
  }
  return pairs
}

describe('readable overview wrapping', () => {
  const chain: LayoutInputEdge[] = Array.from({ length: 9 }, (_, i) => ({
    source: `n${i}`,
    target: `n${i + 1}`,
  }))
  const chainIds = Array.from({ length: 10 }, (_, i) => `n${i}`)

  it('starts each row at the left instead of growing into a diagonal', () => {
    const placed = autoLayout(
      chainIds.map((id) => ({ id })),
      chain,
      { maxRowWidth: 500 },
    )
    const rows = new Set([...placed.values()].map((p) => Math.round(p.y)))
    const columns = new Set([...placed.values()].map((p) => Math.round(p.x)))
    expect(rows.size).toBeGreaterThan(1)
    expect(columns.size).toBe(2)
    expect(placed.get('n2')!.x).toBe(placed.get('n0')!.x)
    expect(placed.get('n4')!.x).toBe(placed.get('n0')!.x)
    // A wrap connector may turn back into the adjacent row; that is the accepted
    // trade for keeping the whole flow on screen at a readable scale.
    expect(backwardForwardEdges(placed, chain, []).length).toBeGreaterThan(0)
  })

  it('keeps the wrapped rows free of overlaps', () => {
    const placed = autoLayout(
      chainIds.map((id) => ({ id })),
      chain,
      { maxRowWidth: 500 },
    )
    expect(overlappingPairs(placed)).toEqual([])
  })

  it('keeps a fork and its merge on one axis instead of wrapping between them', () => {
    // n2 has two forward paths to n6: the direct edge and n3 → n4 → n5 → n6.
    // They form one branch unit, even though the unit is wider than a row.
    const edges = [...chain, { source: 'n2', target: 'n6' }]
    const placed = autoLayout(
      chainIds.map((id) => ({ id })),
      edges,
      { maxRowWidth: 740 },
    )
    expect(placed.get('n6')!.y).toBe(placed.get('n2')!.y)
    expect(placed.get('n6')!.x).toBeGreaterThan(placed.get('n2')!.x)
  })
})

describe('determinism', () => {
  const graph: LayoutInputEdge[] = [
    ...FORWARD,
    FALLBACK,
    { source: 'cond', target: 't', sourceHandle: 'cond-output-fallback' },
  ]
  const seeded = (seed: number): (() => number) => {
    let state = seed
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648
      return state / 2147483648
    }
  }
  const shuffled = (items: readonly string[], random: () => number): string[] => {
    const copy = [...items]
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
    }
    return copy
  }

  it('lays out the same graph identically whatever order the node array is in', () => {
    const reference = JSON.stringify([...layout(IDS, graph)])
    for (const seed of [1, 7, 42, 99, 1234]) {
      const random = seeded(seed)
      const ordered = shuffled(IDS, random)
      expect(JSON.stringify([...layout(ordered, graph)]), `seed ${seed}`).toBe(reference)
    }
  })

  it('positions every node exactly once and drops none', () => {
    const placed = layout(IDS, graph)
    expect([...placed.keys()].sort()).toEqual([...IDS].sort())
  })
})
