/**
 * Canvas port derivation for the `conditions` block: one output handle per
 * configured path plus the "no path matched" port, and the edge bookkeeping
 * that follows from those ids (heal on load, prune when a path is deleted).
 */
import { describe, expect, it } from 'vitest'
import type { Edge, Node } from '@xyflow/react'

import { branchHandlesFor } from '../src/workflow-editor/flow/BlockNode'
import { healEdgeHandles, pruneRemovedPortEdges } from '../src/workflow-editor/flow/connections'

const CONDITIONS = { id: 'conditions', inputs: 1, outputs: 2 }

function conditionsNode(paths?: unknown): Node {
  return {
    id: 'gate',
    type: 'block',
    position: { x: 0, y: 0 },
    data: { block: CONDITIONS, blockData: paths === undefined ? {} : { paths } },
  } as unknown as Node
}

const targetNode = (): Node =>
  ({
    id: 'body',
    type: 'block',
    position: { x: 0, y: 0 },
    data: { block: { id: 'mark', inputs: 1, outputs: 1 } },
  }) as unknown as Node

function edge(sourceHandle: string, target = 'body'): Edge {
  return {
    id: `e-${sourceHandle}`,
    source: 'gate',
    target,
    sourceHandle,
    targetHandle: 'mark-input-1',
    type: 'custom',
  }
}

const TWO_PATHS = [
  { id: 'p1', name: 'Logged in', conditions: [] },
  { id: 'p2', name: 'Cart ready', conditions: [] },
]

describe('conditions block · output ports', () => {
  it('renders one named port per path plus the no-match port', () => {
    expect(branchHandlesFor(CONDITIONS, { paths: TWO_PATHS })).toEqual([
      { idSuffix: 'output-p1', label: 'Logged in' },
      { idSuffix: 'output-p2', label: 'Cart ready' },
      { idSuffix: 'output-none', label: 'fallback' },
    ])
  })

  it('keeps the no-match port on a block with no path yet', () => {
    expect(branchHandlesFor(CONDITIONS, {})).toEqual([
      { idSuffix: 'output-none', label: 'fallback' },
    ])
  })

  it('falls back to a positional name for an unnamed path', () => {
    const handles = branchHandlesFor(CONDITIONS, { paths: [{ id: 'p9', conditions: [] }] })
    expect(handles?.[0]).toEqual({ idSuffix: 'output-p9', label: 'Path 1' })
  })
})

describe('healEdgeHandles · per-path handles', () => {
  it('keeps a path edge anchored instead of re-anchoring it to output-1', () => {
    const out = healEdgeHandles(
      [conditionsNode(TWO_PATHS), targetNode()],
      [edge('conditions-output-p2')],
    )
    expect(out[0]!.sourceHandle).toBe('conditions-output-p2')
  })

  it('re-anchors a legacy true/false edge onto the first path', () => {
    const out = healEdgeHandles(
      [conditionsNode(TWO_PATHS), targetNode()],
      [edge('conditions-output-1')],
    )
    expect(out[0]!.sourceHandle).toBe('conditions-output-p1')
  })

  it('still re-anchors an unknown handle on a non-branch block to output-1', () => {
    const out = healEdgeHandles(
      [targetNode(), conditionsNode(TWO_PATHS)],
      [
        {
          ...edge('mark-output-9'),
          source: 'body',
          target: 'gate',
          targetHandle: 'conditions-input-1',
        },
      ],
    )
    expect(out[0]!.sourceHandle).toBe('mark-output-1')
  })
})

describe('pruneRemovedPortEdges · deleting a path', () => {
  it('drops the deleted path edge and keeps the rest', () => {
    const edges = [
      edge('conditions-output-p1'),
      edge('conditions-output-p2'),
      edge('conditions-output-none'),
    ]
    const out = pruneRemovedPortEdges(CONDITIONS, { paths: [TWO_PATHS[1]!] }, 'gate', edges)
    expect(out.map((e) => e.sourceHandle)).toEqual([
      'conditions-output-p2',
      'conditions-output-none',
    ])
  })

  it('keeps the error-fallback edge, which no path owns', () => {
    const out = pruneRemovedPortEdges(CONDITIONS, { paths: [] }, 'gate', [
      edge('conditions-output-fallback'),
    ])
    expect(out).toHaveLength(1)
  })

  it('leaves other nodes edges and non-branch blocks untouched', () => {
    const edges = [
      { ...edge('conditions-output-p1'), source: 'other' },
      { ...edge('mark-output-1'), source: 'body' },
    ]
    const out = pruneRemovedPortEdges(CONDITIONS, { paths: [] }, 'gate', edges)
    expect(out).toEqual(edges)
  })
})
