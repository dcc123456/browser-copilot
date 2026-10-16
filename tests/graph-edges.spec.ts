import { describe, expect, it } from 'vitest'
import {
  FALLBACK_HANDLE_SUFFIX,
  closesCycle,
  incomingNormalEdges,
  isFallbackHandle,
  loopBackEdgeIds,
  reverseReachable,
  type EdgeLike,
} from '../src/lib/workflow/graph-edges'

/**
 * Edge semantics shared by the canvas and the edit-time variable picker.
 *
 * The picker decides "what can hold a value by the time this node runs" from
 * these answers, and the patcher splices a new node into "the normal incoming
 * edge" — so both must agree with what the canvas already does when it replaces
 * an occupied input. Fallback branches and loop-backs are the two shapes that
 * look like an incoming edge but are not one.
 */

const edge = (source: string, target: string, sourceHandle?: string): EdgeLike => ({
  id: `${source}->${target}${sourceHandle ? `-${sourceHandle}` : ''}`,
  source,
  target,
  sourceHandle,
})

const fallbackHandle = (blockId: string): string => `${blockId}${FALLBACK_HANDLE_SUFFIX}`

describe('isFallbackHandle', () => {
  it('recognises only the fallback output suffix', () => {
    expect(isFallbackHandle(fallbackHandle('conditions'))).toBe(true)
    expect(isFallbackHandle('conditions-output-1')).toBe(false)
    expect(isFallbackHandle(undefined)).toBe(false)
    expect(isFallbackHandle(null)).toBe(false)
  })
})

describe('closesCycle', () => {
  it('is true when the target already reaches the source', () => {
    const edges = [edge('a', 'b'), edge('b', 'c')]
    expect(closesCycle(edges, 'c', 'a')).toBe(true)
    expect(closesCycle(edges, 'a', 'c')).toBe(false)
  })

  it('treats a self connection as a cycle', () => {
    expect(closesCycle([], 'a', 'a')).toBe(true)
  })

  it('ignores fallback edges when following the normal flow', () => {
    // a → b, and b's fallback branch points back at a. Drawing a → b again must
    // not count as closing a cycle: the fallback is error recovery, not flow.
    const edges = [edge('a', 'b'), edge('b', 'a', fallbackHandle('b'))]
    expect(closesCycle(edges, 'a', 'b')).toBe(false)
  })
})

describe('loopBackEdgeIds / incomingNormalEdges', () => {
  it('marks the retry edge, and the main chain it loops back onto', () => {
    const edges = [edge('t', 'a'), edge('a', 'b'), edge('b', 'a', 'conditions-output-2')]
    // Both halves of the cycle test true against a FIXED graph: b already
    // reaches a, and a already reaches b. That is exactly how the canvas decides
    // which edge may replace an occupied input, so the picker inherits the same
    // answer instead of inventing a stricter one. `t -> a` stays normal.
    expect([...loopBackEdgeIds(edges)].sort()).toEqual(['a->b', 'b->a-conditions-output-2'])
  })

  it('keeps the main chain as the only normal feed of a node', () => {
    const main = edge('t', 'a')
    const retry = edge('b', 'a', 'conditions-output-2')
    const recovery = edge('b', 'a', fallbackHandle('b'))
    const edges = [main, edge('a', 'b'), retry, recovery]
    expect(incomingNormalEdges(edges, 'a')).toEqual([main])
  })

  it('returns nothing for a node with no incoming edge', () => {
    expect(incomingNormalEdges([edge('a', 'b')], 'a')).toEqual([])
  })
})

describe('reverseReachable', () => {
  it('walks ancestors, excluding the node itself', () => {
    const edges = [edge('t', 'a'), edge('a', 'b'), edge('b', 'c'), edge('x', 'c')]
    expect([...reverseReachable(edges, 'c')].sort()).toEqual(['a', 'b', 't', 'x'])
    expect(reverseReachable(edges, 't').size).toBe(0)
  })

  it('does not loop forever on a cycle', () => {
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]
    expect([...reverseReachable(edges, 'b')].sort()).toEqual(['a', 'c'])
  })

  it('follows fallback and loop-back edges too', () => {
    // A loop body's outputs really are defined by the time the retry path runs
    // them, so the picker offers them; iteration-one undefined is the run's
    // business, not a reason to hide the name.
    const edges = [edge('a', 'b'), edge('b', 'a', 'conditions-output-2')]
    expect([...reverseReachable(edges, 'a')]).toEqual(['b'])
  })
})
