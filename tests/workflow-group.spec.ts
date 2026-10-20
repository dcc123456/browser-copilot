/**
 * The group container's data contract (spec
 * `specs/2026-10-19-workflow-group-block-design.md` §3.1).
 *
 * Children live inside the group node as the interoperable Automa shape
 * `{ id, itemId, data }`; they are not graph nodes. So everything that has to
 * know about them — reading, refusing an illegal child, folding a selection in,
 * unfolding it again — is here rather than in the canvas or the engine.
 */
import { describe, expect, it } from 'vitest'
import {
  GROUP_BLOCK_ID,
  blockIdOf,
  groupChildrenOf,
  groupChildProblems,
  isGroupNode,
  planGroupPack,
  unpackGroupNode,
  type GroupPackResult,
  type WorkflowGroupChild,
} from '../src/lib/workflow/group'
import type { WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

const child = (
  id: string,
  itemId: string,
  data: Record<string, unknown> = {},
): WorkflowGroupChild => ({
  id,
  itemId,
  data,
})

function node(
  id: string,
  blockId: string,
  extra: Record<string, unknown> = {},
  position = { x: 0, y: 0 },
): WorkflowNode {
  return { id, label: blockId, position, data: { blockId, ...extra } }
}

function edge(source: string, target: string): WorkflowEdge {
  return { id: `e-${source}-${target}`, source, target }
}

function groupNode(children: unknown[], position = { x: 0, y: 0 }): WorkflowNode {
  return {
    id: 'g1',
    label: 'Blocks group',
    position,
    data: { blockId: GROUP_BLOCK_ID, name: '收集列表', blocks: children, disableBlock: false },
  }
}

/** Unwrap the failure so a wrong expectation names the reason instead of a diff. */
function failureReason(result: GroupPackResult): string {
  if ('plan' in result) throw new Error('expected the pack to be refused')
  return result.failure.reason
}

function unwrapPlan(result: GroupPackResult) {
  if ('failure' in result) throw new Error(`expected a plan, got ${result.failure.reason}`)
  return result.plan
}

describe('reading a group', () => {
  it('recognises the group node', () => {
    expect(isGroupNode(groupNode([]))).toBe(true)
    expect(isGroupNode(node('n1', 'event-click'))).toBe(false)
    expect(blockIdOf(node('n1', 'forms'))).toBe('forms')
  })

  it('reads the upstream child shape', () => {
    expect(
      groupChildrenOf(
        groupNode([
          { id: 'event-click', itemId: 'a', data: { selector: '#one' } },
          { id: 'forms', itemId: 'b', data: { selector: '#two' } },
        ]),
      ),
    ).toEqual([
      child('event-click', 'a', { selector: '#one' }),
      child('forms', 'b', { selector: '#two' }),
    ])
  })

  it('drops entries that cannot describe a block', () => {
    expect(
      groupChildrenOf(
        groupNode([null, 'x', { id: 'forms' }, { itemId: 'b' }, { id: 'forms', itemId: 'c' }]),
      ),
    ).toEqual([child('forms', 'c')])
  })

  it('has no children for a plain node or an empty list', () => {
    expect(groupChildrenOf(node('n1', 'forms'))).toEqual([])
    expect(groupChildrenOf(groupNode([]))).toEqual([])
  })

  it('refuses unknown blocks and blocks a linear chain cannot hold', () => {
    expect(
      groupChildProblems([
        { id: 'not-a-block', itemId: 'a', data: {} },
        { id: 'conditions', itemId: 'b', data: {} },
        { id: 'event-click', itemId: 'c', data: {} },
      ]),
    ).toEqual([
      { itemId: 'a', blockId: 'not-a-block', reason: 'unknown_block' },
      { itemId: 'b', blockId: 'conditions', reason: 'cannot_be_in_group' },
    ])
  })
})

describe('packing a selection into a group', () => {
  const chain = [
    node('n1', 'event-click', { selector: '#a' }, { x: 100, y: 40 }),
    node('n2', 'forms', {}, { x: 200, y: 40 }),
    node('n3', 'delay', {}, { x: 300, y: 40 }),
  ]
  const chainEdges = [edge('n1', 'n2'), edge('n2', 'n3')]

  it('serialises the chain in execution order and re-anchors its edges', () => {
    const plan = unwrapPlan(
      planGroupPack(
        [node('start', 'trigger'), ...chain, node('end', 'new-tab')],
        [edge('start', 'n1'), ...chainEdges, edge('n3', 'end')],
        ['n1', 'n2', 'n3'],
        'g1',
        '收集列表',
      ),
    )

    expect(groupChildrenOf(plan.group)).toEqual([
      child('event-click', 'n1', { selector: '#a' }),
      child('forms', 'n2'),
      child('delay', 'n3'),
    ])
    expect(plan.group.data.name).toBe('收集列表')
    expect(plan.group.position).toEqual({ x: 100, y: 40 })
    expect(plan.removedIds).toEqual(['n1', 'n2', 'n3'])
    expect(plan.droppedEdgeIds).toEqual(['e-n1-n2', 'e-n2-n3'])
    expect(plan.keptEdges).toEqual([
      { id: 'e-start-n1', source: 'start', target: 'g1', targetHandle: 'blocks-group-input-1' },
      { id: 'e-n3-end', source: 'g1', target: 'end', sourceHandle: 'blocks-group-output-1' },
    ])
  })

  it('needs at least two nodes', () => {
    expect(failureReason(planGroupPack(chain, chainEdges, ['n1'], 'g1', ''))).toBe('too_few')
  })

  it('refuses a selection that is not one path', () => {
    const four = [
      node('n1', 'event-click'),
      node('n2', 'forms'),
      node('n3', 'delay'),
      node('n4', 'press-key'),
    ]
    // A fork inside the selection.
    expect(
      failureReason(
        planGroupPack(four, [edge('n1', 'n2'), edge('n1', 'n3')], ['n1', 'n2', 'n3'], 'g1', ''),
      ),
    ).toBe('not_a_chain')
    // Two disjoint pairs.
    expect(
      failureReason(
        planGroupPack(
          four,
          [edge('n1', 'n2'), edge('n3', 'n4')],
          ['n1', 'n2', 'n3', 'n4'],
          'g1',
          '',
        ),
      ),
    ).toBe('not_a_chain')
    // A cycle has no head at all.
    expect(
      failureReason(
        planGroupPack(
          four.slice(0, 3),
          [edge('n1', 'n2'), edge('n2', 'n3'), edge('n3', 'n1')],
          ['n1', 'n2', 'n3'],
          'g1',
          '',
        ),
      ),
    ).toBe('not_a_chain')
  })

  it('refuses a connection leaving or entering the middle of the chain', () => {
    // `n2` runs before `n3`, so its edge to `end` must not silently move.
    expect(
      failureReason(
        planGroupPack(
          [node('start', 'trigger'), ...chain, node('end', 'new-tab')],
          [edge('start', 'n1'), edge('n1', 'n2'), edge('n2', 'n3'), edge('n2', 'end')],
          ['n1', 'n2', 'n3'],
          'g1',
          '',
        ),
      ),
    ).toBe('stray_connection')
    expect(
      failureReason(
        planGroupPack(
          [...chain, node('start', 'trigger')],
          [edge('n1', 'n2'), edge('n2', 'n3'), edge('start', 'n2')],
          ['n1', 'n2', 'n3'],
          'g1',
          '',
        ),
      ),
    ).toBe('stray_connection')
  })

  it('refuses children the group cannot run', () => {
    for (const blockId of ['trigger', 'conditions', 'loop-data', 'blocks-group', 'not-a-block']) {
      const nodes = [node('n1', blockId), node('n2', 'forms')]
      expect(
        failureReason(planGroupPack(nodes, [edge('n1', 'n2')], ['n1', 'n2'], 'g1', '')),
        blockId,
      ).toBe('forbidden_child')
    }
  })
})

describe('unfolding a group', () => {
  const children = [
    child('event-click', 'a', { selector: '#one' }),
    child('forms', 'b', { selector: '#two' }),
  ]

  it('restores nodes, chains them, and re-anchors the group edges', () => {
    const result = unpackGroupNode(
      groupNode(children, { x: 100, y: 40 }),
      [
        { id: 'e-in', source: 'start', target: 'g1', targetHandle: 'blocks-group-input-1' },
        { id: 'e-out', source: 'g1', target: 'end', sourceHandle: 'blocks-group-output-1' },
      ],
      { idFactory: () => 'fresh', takenIds: new Set(['start', 'end']) },
    )

    expect(result.nodes).toEqual([
      {
        id: 'a',
        label: 'Click element',
        position: { x: 100, y: 40 },
        data: { selector: '#one', blockId: 'event-click' },
      },
      {
        id: 'b',
        label: 'Forms',
        position: { x: 380, y: 40 },
        data: { selector: '#two', blockId: 'forms' },
      },
    ])
    expect(result.edges).toEqual([
      { id: 'e-in', source: 'start', target: 'a', targetHandle: 'event-click-input-1' },
      {
        id: 'edge-a-b',
        source: 'a',
        target: 'b',
        sourceHandle: 'event-click-output-1',
        targetHandle: 'forms-input-1',
      },
      { id: 'e-out', source: 'b', target: 'end', sourceHandle: 'forms-output-1' },
    ])
  })

  it('replaces an id that is already on the canvas', () => {
    const result = unpackGroupNode(groupNode(children), [], {
      idFactory: () => 'fresh',
      takenIds: new Set(['a']),
    })
    expect(result.nodes.map((n) => n.id)).toEqual(['fresh', 'b'])
  })

  it('bridges around an empty group', () => {
    const result = unpackGroupNode(groupNode([]), [edge('start', 'g1'), edge('g1', 'end')], {
      idFactory: () => 'fresh',
      takenIds: new Set(),
    })
    expect(result.nodes).toEqual([])
    expect(result.edges).toEqual([{ id: 'edge-start-end', source: 'start', target: 'end' }])
  })

  it('round-trips a chain through pack and unpack', () => {
    const nodes = [node('n1', 'event-click', { selector: '#a' }), node('n2', 'forms')]
    const plan = unwrapPlan(
      planGroupPack(nodes, [edge('n1', 'n2')], ['n1', 'n2'], 'g1', '收集列表'),
    )
    const restored = unpackGroupNode(plan.group, plan.keptEdges, {
      idFactory: () => 'fresh',
      takenIds: new Set(['start', 'end']),
    })
    expect(restored.nodes.map((n) => n.id)).toEqual(['n1', 'n2'])
    expect(restored.nodes.map((n) => n.data.blockId)).toEqual(['event-click', 'forms'])
    expect(groupChildrenOf(plan.group)).toEqual([
      child('event-click', 'n1', { selector: '#a' }),
      child('forms', 'n2'),
    ])
  })
})
