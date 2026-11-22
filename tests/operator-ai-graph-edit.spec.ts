import { describe, expect, it } from 'vitest'
import {
  applyGraphEdits,
  operatorDigestOf,
  parseOperatorAdviseReply,
  type OperatorEditOp,
} from '../src/lib/workflow/operator-advise'
import type { WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

/**
 * Batch 1 of the "position is a parameter, not a selection" work: the digest
 * names every node by id and prints the wiring (branches and loops included), an
 * answer carries a LIST of operations, and the whole list lands or nothing does.
 */

const node = (
  id: string,
  blockId: string,
  data: Record<string, unknown> = {},
  position = { x: 0, y: 0 },
): WorkflowNode => ({ id, label: blockId, position, data: { blockId, ...data } })

const edge = (source: string, target: string): WorkflowEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  sourceHandle: `${source}-output-1`,
  targetHandle: `${target}-input-1`,
})

function fixture() {
  const nodes = [
    node('trigger', 'trigger', { type: 'manual' }),
    node('open', 'open-url', { url: 'https://shop.test/p' }),
    node('seed', 'javascript-code', {
      code: "automaSetVariable('noteIds', ['a','b'])",
      outputVariables: ['noteIds'],
    }),
    node('loop', 'loop-data', { loopThrough: 'variable', variableName: 'noteIds' }),
    node('submit', 'javascript-code', { code: 'submit(loopItem)' }),
    node('break', 'loop-breakpoint', { loopId: '' }),
    node('save', 'javascript-code', { code: "automaSetVariable('csv','x')" }),
    node('notify', 'javascript-code', { code: 'notify()' }),
  ]
  const edges = [
    edge('trigger', 'open'),
    edge('open', 'seed'),
    edge('seed', 'loop'),
    edge('loop', 'submit'),
    edge('submit', 'break'),
    edge('break', 'save'),
    edge('save', 'notify'),
  ]
  return { nodes, edges }
}

const offer = ['trigger', 'open-url', 'javascript-code', 'loop-data', 'loop-breakpoint']

let counter = 0
const newId = () => `new-${(counter += 1)}`

describe('graph digest', () => {
  it('names every node by id and prints the wiring, not just the linear chain', () => {
    const digest = operatorDigestOf(fixture(), 'seed')
    expect(digest).toContain('[seed] javascript-code')
    expect(digest).toContain('<< selected')
    // Branches and loop exits are invisible in an ordered list; the wiring shows
    // them, and the id on both ends is what an answer has to name.
    expect(digest).toContain('Wiring (source handle -> target):')
    expect(digest).toContain('[loop] loop-output-1 -> [submit]')
    expect(digest).toContain('[break] break-output-1 -> [save]')
  })

  it('tells each step which variables it can actually read where it stands', () => {
    const digest = operatorDigestOf(fixture())
    const lines = digest.split('\n')
    const submit = lines.find((line) => line.includes('[submit]'))!
    const save = lines.find((line) => line.includes('[save]'))!
    const open = lines.find((line) => line.includes('[open]'))!
    // Inside the body: the loop variables exist, and the upstream variable arrives.
    expect(submit).toContain('loopItem')
    expect(submit).toContain('noteIds')
    // After the loop: the loop variables are gone.
    expect(save).not.toContain('loopItem')
    expect(save).toContain('noteIds')
    // Before the producer: not a value yet.
    expect(open).not.toContain('noteIds')
  })

  it('names the steps the user has not wired yet, so they can still be targeted', () => {
    const graph = fixture()
    graph.nodes.push(node('orphan', 'javascript-code', { code: 'x' }))
    const digest = operatorDigestOf(graph)
    expect(digest).toContain('Not wired to anything yet:')
    expect(digest).toContain('[orphan]')
  })
})

describe('ops answers', () => {
  it('reads an insert + patch answer as two operations', () => {
    const reply = parseOperatorAdviseReply(
      JSON.stringify({
        reply: 'Inserted the dedup step and pointed the save step at the CSV.',
        ops: [
          {
            kind: 'insert',
            anchorNodeId: 'seed',
            side: 'after',
            proposals: [{ blockId: 'javascript-code', data: { code: 'dedup()' } }],
          },
          {
            kind: 'patch',
            nodeId: 'save',
            action: 'edit',
            proposals: [{ blockId: 'javascript-code', data: { code: 'csv()' } }],
          },
        ],
      }),
      offer,
    )
    expect(reply?.ops).toHaveLength(2)
    expect(reply?.ops?.[0]).toMatchObject({ kind: 'insert', anchorNodeId: 'seed', side: 'after' })
    expect(reply?.ops?.[1]).toMatchObject({ kind: 'patch', nodeId: 'save', action: 'edit' })
  })

  it('refuses a malformed ops list instead of landing half of it', () => {
    const reply = parseOperatorAdviseReply(
      JSON.stringify({
        reply: 'x',
        ops: [{ kind: 'insert', anchorNodeId: 'seed', side: 'middle', proposals: [] }],
      }),
      offer,
    )
    expect(reply).toBeNull()
  })

  it('refuses an operation whose operator this build never offered', () => {
    const reply = parseOperatorAdviseReply(
      JSON.stringify({
        reply: 'x',
        ops: [
          {
            kind: 'insert',
            anchorNodeId: 'seed',
            side: 'after',
            proposals: [{ blockId: 'definitely-not-offered', data: {} }],
          },
        ],
      }),
      offer,
    )
    expect(reply).toBeNull()
  })
})

describe('atomic graph edits', () => {
  it('inserts after an anchor and patches another step in the same answer', () => {
    const before = fixture()
    const dedup: OperatorEditOp = {
      kind: 'insert',
      anchorNodeId: 'open',
      side: 'after',
      proposals: [{ blockId: 'javascript-code', data: { code: 'dedup()' }, rationale: 'dedup' }],
    }
    const patch: OperatorEditOp = {
      kind: 'patch',
      nodeId: 'save',
      action: 'edit',
      proposals: [{ blockId: 'javascript-code', data: { code: 'csv()' }, rationale: 'csv' }],
    }
    const result = applyGraphEdits(before, [dedup, patch], newId)

    expect(result.problems).toEqual([])
    expect(result.added).toHaveLength(1)
    const added = result.added[0]!
    // Spliced BETWEEN the anchor and what it used to lead to.
    expect(result.edges.some((e) => e.source === 'open' && e.target === added.id)).toBe(true)
    expect(result.edges.some((e) => e.source === added.id && e.target === 'seed')).toBe(true)
    expect(result.edges.some((e) => e.source === 'open' && e.target === 'seed')).toBe(false)
    // The patch landed on the step it named, not on a selection.
    const saved = result.nodes.find((n) => n.id === 'save')!
    expect(saved.data['code']).toBe('csv()')
  })

  it('inserts before an anchor', () => {
    const before = fixture()
    const result = applyGraphEdits(
      before,
      [
        {
          kind: 'insert',
          anchorNodeId: 'loop',
          side: 'before',
          proposals: [{ blockId: 'javascript-code', data: { code: 'prep()' }, rationale: 'prep' }],
        },
      ],
      newId,
    )
    expect(result.problems).toEqual([])
    const added = result.added[0]!
    expect(result.edges.some((e) => e.source === added.id && e.target === 'loop')).toBe(true)
    expect(result.edges.some((e) => e.source === 'seed' && e.target === added.id)).toBe(true)
  })

  it('changes NOTHING when one operation names a node that is not there', () => {
    const before = fixture()
    const result = applyGraphEdits(
      before,
      [
        {
          kind: 'insert',
          anchorNodeId: 'seed',
          side: 'after',
          proposals: [{ blockId: 'javascript-code', data: { code: 'dedup()' }, rationale: '' }],
        },
        {
          kind: 'patch',
          nodeId: 'gone',
          action: 'edit',
          proposals: [{ blockId: 'javascript-code', data: { code: 'x' }, rationale: '' }],
        },
      ],
      newId,
    )
    expect(result.problems).toEqual([{ index: 1, problem: 'unknown-target' }])
    expect(result.added).toEqual([])
    expect(result.nodes).toEqual(before.nodes)
    expect(result.edges).toEqual(before.edges)
  })

  it('moves a step next to an anchor, carrying its wiring', () => {
    const before = fixture()
    // `notify` is the tail and nobody reads it; move it after `seed`.
    const result = applyGraphEdits(
      before,
      [{ kind: 'move', nodeId: 'notify', anchorNodeId: 'seed', side: 'after' }],
      newId,
    )
    expect(result.problems).toEqual([])
    // Its old incoming edge is gone, the anchor now feeds it, and what the
    // anchor used to lead to hangs off the moved step.
    expect(result.edges.some((e) => e.source === 'save' && e.target === 'notify')).toBe(false)
    expect(result.edges.some((e) => e.source === 'seed' && e.target === 'notify')).toBe(true)
    expect(result.edges.some((e) => e.source === 'notify' && e.target === 'loop')).toBe(true)
    expect(result.nodes.map((n) => n.id)).toContain('notify')
  })

  it('refuses a move that would put a step inside its own downstream', () => {
    const before = fixture()
    // Moving `open` after `seed` is fine, but `open` after `save` reaches back
    // through `open` itself — a cycle the editor must not create.
    const result = applyGraphEdits(
      before,
      [{ kind: 'move', nodeId: 'open', anchorNodeId: 'save', side: 'after' }],
      newId,
    )
    expect(result.problems).toEqual([{ index: 0, problem: 'move-cycle' }])
    expect(result.nodes).toEqual(before.nodes)
    expect(result.edges).toEqual(before.edges)
  })

  it('deletes a step and stitches its neighbours back together', () => {
    const before = fixture()
    // `open` produces nothing anybody reads, so the delete is allowed; the edge
    // that fed it now feeds what came after it.
    const result = applyGraphEdits(
      before,
      [{ kind: 'delete', nodeId: 'open', reconnect: true }],
      newId,
    )
    expect(result.problems).toEqual([])
    expect(result.nodes.map((n) => n.id)).not.toContain('open')
    expect(result.edges.some((e) => e.source === 'trigger' && e.target === 'seed')).toBe(true)
    expect(result.edges.some((e) => e.source === 'open' || e.target === 'open')).toBe(false)
  })

  it('refuses to delete the entry point', () => {
    const before = fixture()
    const result = applyGraphEdits(
      before,
      [{ kind: 'delete', nodeId: 'trigger', reconnect: true }],
      newId,
    )
    expect(result.problems).toEqual([{ index: 0, problem: 'delete-entry-point' }])
    expect(result.nodes).toEqual(before.nodes)
  })

  it('refuses a delete that would leave a downstream step reading a gone variable', () => {
    const before = fixture()
    // `seed` produces noteIds and `loop` reads it as its source. Deleting the
    // producer must be refused at ANSWER time, not discovered at run time.
    const result = applyGraphEdits(
      before,
      [{ kind: 'delete', nodeId: 'seed', reconnect: true }],
      newId,
    )
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toMatchObject({
      index: -1,
      problem: 'dangling-reference',
      nodeId: 'loop',
      variables: ['noteIds'],
    })
    expect(result.nodes).toEqual(before.nodes)
    expect(result.edges).toEqual(before.edges)
  })

  it('allows a delete that removes no producer anything reads', () => {
    const before = fixture()
    // `notify` produces nothing anyone reads, and removing it leaves the loop's
    // breakpoint its exit (`save`) intact.
    const result = applyGraphEdits(
      before,
      [{ kind: 'delete', nodeId: 'notify', reconnect: true }],
      newId,
    )
    expect(result.problems).toEqual([])
    expect(result.nodes.map((n) => n.id)).not.toContain('notify')
  })

  it('allows a move that keeps the producer, even though the step changes place', () => {
    const before = fixture()
    const result = applyGraphEdits(
      before,
      [{ kind: 'move', nodeId: 'notify', anchorNodeId: 'open', side: 'after' }],
      newId,
    )
    expect(result.problems).toEqual([])
    expect(result.nodes.map((n) => n.id)).toContain('seed')
  })

  it('refuses a move that would leave a loop without an exit', () => {
    const before = fixture()
    // Moving `save` away empties the breakpoint's only outgoing edge: the loop
    // would finish and then stop dead.
    const result = applyGraphEdits(
      before,
      [{ kind: 'move', nodeId: 'save', anchorNodeId: 'submit', side: 'after' }],
      newId,
    )
    expect(result.problems[0]).toMatchObject({
      problem: 'loop-exit-missing',
      nodeId: 'break',
    })
    expect(result.nodes).toEqual(before.nodes)
  })

  it('refuses a move that would take the breakpoint out of its body', () => {
    const before = fixture()
    const result = applyGraphEdits(
      before,
      // In front of `seed` is upstream of the loop, so no cycle — but the
      // breakpoint no longer ends the body it belongs to.
      [{ kind: 'move', nodeId: 'break', anchorNodeId: 'seed', side: 'before' }],
      newId,
    )
    expect(result.problems[0]).toMatchObject({
      problem: 'breakpoint-outside-loop',
      nodeId: 'break',
    })
    expect(result.nodes).toEqual(before.nodes)
  })

  it('refuses deleting the entry point', () => {
    const before = fixture()
    const result = applyGraphEdits(
      before,
      [{ kind: 'delete', nodeId: 'trigger', reconnect: true }],
      newId,
    )
    expect(result.problems).toEqual([{ index: 0, problem: 'delete-entry-point' }])
    expect(result.nodes).toEqual(before.nodes)
  })

  it('refuses an empty answer instead of touching the canvas', () => {
    const before = fixture()
    const result = applyGraphEdits(before, [], newId)
    expect(result.problems).toEqual([{ index: 0, problem: 'no-operations' }])
    expect(result.nodes).toEqual(before.nodes)
  })
})
