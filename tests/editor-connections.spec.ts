import { describe, it, expect } from 'vitest'
import {
  applyConnection,
  edgeClosesCycle,
  isFallbackHandle,
} from '../src/workflow-editor/flow/connections'
import type { Connection, Edge } from '@xyflow/react'

function edge(p: Partial<Edge>): Edge {
  return {
    id: p.id ?? `e-${Math.random().toString(36).slice(2)}`,
    source: p.source ?? 'a',
    target: p.target ?? 'b',
    sourceHandle: p.sourceHandle,
    targetHandle: p.targetHandle,
    type: 'custom',
  }
}

function conn(p: Partial<Connection>): Connection {
  return {
    source: p.source ?? 'c',
    target: p.target ?? 'a',
    sourceHandle: p.sourceHandle ?? 'c-output-1',
    targetHandle: p.targetHandle ?? 'a-input-1',
  }
}

describe('applyConnection (canvas edge bookkeeping)', () => {
  it('replaces the edge occupying a normal input handle', () => {
    const eds = [
      edge({
        id: 'e1',
        source: 'a',
        target: 'b',
        sourceHandle: 'a-output-1',
        targetHandle: 'b-input-1',
      }),
    ]
    const out = applyConnection(
      eds,
      conn({ source: 'c', target: 'b', sourceHandle: 'c-output-1', targetHandle: 'b-input-1' }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.source).toBe('c')
    expect(out[0]!.target).toBe('b')
  })

  it('treats an identical re-draw as a no-op', () => {
    const eds = [
      edge({
        id: 'e1',
        source: 'a',
        target: 'b',
        sourceHandle: 'a-output-1',
        targetHandle: 'b-input-1',
      }),
    ]
    const out = applyConnection(
      eds,
      conn({ source: 'a', target: 'b', sourceHandle: 'a-output-1', targetHandle: 'b-input-1' }),
    )
    expect(out).toBe(eds)
  })

  it('ignores empty or self-loop connections', () => {
    const eds = [edge({ id: 'e1' })]
    // Runtime guard: React Flow can emit a nullish source on aborted drags.
    const empty = {
      source: null,
      target: 'a',
      sourceHandle: 'c-output-1',
      targetHandle: 'a-input-1',
    } as unknown as Connection
    expect(applyConnection(eds, empty)).toBe(eds)
    expect(applyConnection(eds, conn({ source: 'a', target: 'a' }))).toBe(eds)
  })

  it('keeps the target node’s incoming edge when a fallback connects to it', () => {
    // a → b → c, plus the fallback c –fallback→ a. Node a's incoming edge
    // (from trigger t) must survive the fallback connection.
    const eds = [
      edge({
        id: 'e1',
        source: 't',
        target: 'a',
        sourceHandle: 't-output-1',
        targetHandle: 'a-input-1',
      }),
      edge({
        id: 'e2',
        source: 'a',
        target: 'b',
        sourceHandle: 'a-output-1',
        targetHandle: 'b-input-1',
      }),
      edge({
        id: 'e3',
        source: 'b',
        target: 'c',
        sourceHandle: 'b-output-1',
        targetHandle: 'c-input-1',
      }),
    ]
    const out = applyConnection(
      eds,
      conn({
        source: 'c',
        target: 'a',
        sourceHandle: 'c-output-fallback',
        targetHandle: 'a-input-1',
      }),
    )
    expect(out.map((e) => e.id)).toContain('e1')
    expect(out.map((e) => e.id)).toContain('e2')
    expect(out.map((e) => e.id)).toContain('e3')
    const fb = out.find((e) => isFallbackHandle(e.sourceHandle))
    expect(fb?.source).toBe('c')
    expect(fb?.target).toBe('a')
  })

  it('moves a node’s fallback branch instead of stacking a second one', () => {
    const eds = [
      edge({
        id: 'e1',
        source: 't',
        target: 'a',
        sourceHandle: 't-output-1',
        targetHandle: 'a-input-1',
      }),
      edge({
        id: 'e2',
        source: 'c',
        target: 'a',
        sourceHandle: 'c-output-fallback',
        targetHandle: 'a-input-1',
      }),
    ]
    const out = applyConnection(
      eds,
      conn({
        source: 'c',
        target: 'b',
        sourceHandle: 'c-output-fallback',
        targetHandle: 'b-input-1',
      }),
    )
    const fallbacks = out.filter((e) => isFallbackHandle(e.sourceHandle))
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]!.target).toBe('b')
    // The redrawn normal input edge of the new fallback target survives.
    expect(out.map((e) => e.id)).toContain('e1')
  })

  it('keeps the target’s incoming edge when a branch loops back to an earlier node', () => {
    // t → a → b (element-exists), then b’s "not exists" branch loops back to a.
    // Node a’s normal incoming edge (t → a) must survive — previously the
    // loop-back replaced it and severed the chain.
    const eds = [
      edge({
        id: 'e1',
        source: 't',
        target: 'a',
        sourceHandle: 't-output-1',
        targetHandle: 'a-input-1',
      }),
      edge({
        id: 'e2',
        source: 'a',
        target: 'b',
        sourceHandle: 'a-output-1',
        targetHandle: 'b-input-1',
      }),
    ]
    const out = applyConnection(
      eds,
      conn({
        source: 'b',
        target: 'a',
        sourceHandle: 'element-exists-output-2',
        targetHandle: 'a-input-1',
      }),
    )
    expect(out.map((e) => e.id)).toEqual(['e1', 'e2', expect.any(String)])
    const loopBack = out.find((e) => e.source === 'b' && e.target === 'a')
    expect(loopBack?.sourceHandle).toBe('element-exists-output-2')
  })

  it('moves a branch’s loop-back target when redrawn from the same handle', () => {
    const eds = [
      edge({
        id: 'e1',
        source: 't',
        target: 'a',
        sourceHandle: 't-output-1',
        targetHandle: 'a-input-1',
      }),
      edge({
        id: 'e2',
        source: 'a',
        target: 'b',
        sourceHandle: 'a-output-1',
        targetHandle: 'b-input-1',
      }),
      edge({
        id: 'e3',
        source: 'b',
        target: 'a',
        sourceHandle: 'element-exists-output-2',
        targetHandle: 'a-input-1',
      }),
    ]
    const out = applyConnection(
      eds,
      conn({
        source: 'b',
        target: 't',
        sourceHandle: 'element-exists-output-2',
        targetHandle: 't-input-1',
      }),
    )
    const loopBacks = out.filter((e) => e.source === 'b' && e.sourceHandle === 'element-exists-output-2')
    expect(loopBacks).toHaveLength(1)
    expect(loopBacks[0]!.target).toBe('t')
    // The earlier chain edges are untouched.
    expect(out.map((e) => e.id)).toContain('e1')
    expect(out.map((e) => e.id)).toContain('e2')
  })

  it('does not treat a draw to a disconnected node as a loop-back', () => {
    // A normal draw onto an occupied input still replaces it when the draw
    // closes no cycle (the target merely sits left/upstream on the canvas).
    const eds = [
      edge({
        id: 'e1',
        source: 'a',
        target: 'b',
        sourceHandle: 'a-output-1',
        targetHandle: 'b-input-1',
      }),
    ]
    const out = applyConnection(
      eds,
      conn({ source: 'c', target: 'b', sourceHandle: 'c-output-1', targetHandle: 'b-input-1' }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.source).toBe('c')
  })

  it('edgeClosesCycle detects only edges that close a directed cycle', () => {
    const eds = [
      edge({ source: 'a', target: 'b', sourceHandle: 'a-output-1' }),
      edge({ source: 'b', target: 'c', sourceHandle: 'b-output-1' }),
      edge({ source: 'x', target: 'y', sourceHandle: 'x-output-fallback' }),
    ]
    // b can reach a? No. a can reach b already — drawing b → a closes a cycle.
    expect(edgeClosesCycle(eds, 'b', 'a')).toBe(true)
    expect(edgeClosesCycle(eds, 'c', 'a')).toBe(true)
    expect(edgeClosesCycle(eds, 'a', 'c')).toBe(false)
    // A fallback edge is error-recovery, not part of the cycle test.
    expect(edgeClosesCycle(eds, 'y', 'x')).toBe(false)
    expect(edgeClosesCycle(eds, 'a', 'a')).toBe(true)
  })

  it('keeps existing fallback edges when a normal edge redraws onto the same input', () => {
    const eds = [
      edge({
        id: 'e1',
        source: 'c',
        target: 'a',
        sourceHandle: 'c-output-fallback',
        targetHandle: 'a-input-1',
      }),
      edge({
        id: 'e2',
        source: 't',
        target: 'a',
        sourceHandle: 't-output-1',
        targetHandle: 'a-input-1',
      }),
    ]
    const out = applyConnection(
      eds,
      conn({ source: 'x', target: 'a', sourceHandle: 'x-output-1', targetHandle: 'a-input-1' }),
    )
    // The normal input is replaced (t → a becomes x → a)…
    expect(out.map((e) => e.id)).not.toContain('e2')
    // …but the fallback line into a survives.
    expect(out.map((e) => e.id)).toContain('e1')
  })
})
