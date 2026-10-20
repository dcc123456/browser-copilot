/**
 * A group node runs the children it holds in `data.blocks` (spec
 * `specs/2026-10-19-workflow-group-block-design.md` §3.2).
 *
 * Before this the executor returned `null`, so a group — including every group
 * imported from an Automa file, whose children `fromAutomaExport` keeps verbatim
 * — silently skipped everything inside it. The children now run through the
 * ordinary node path: same interpolation, same skip-on-disabled, same failure
 * semantics — while staying out of the node-id ledgers, because they are not
 * addressable nodes.
 */
import { describe, expect, it } from 'vitest'
import { runWorkflow } from '../src/background/workflow-engine/engine'
import type { BlockExecutor } from '../src/background/workflow-engine/executors'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

function node(id: string, blockId: string, data: Record<string, unknown> = {}): WorkflowNode {
  return { id, label: blockId, position: { x: 0, y: 0 }, data: { blockId, ...data } }
}

function group(children: unknown[], id = 'g'): WorkflowNode {
  return node(id, 'blocks-group', { name: '收集列表', blocks: children })
}

const child = (blockId: string, itemId: string, data: Record<string, unknown> = {}) => ({
  id: blockId,
  itemId,
  data,
})

function workflow(
  nodes: WorkflowNode[],
  edges: { source: string; target: string; sourceHandle?: string }[],
): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: {
      nodes,
      edges: edges.map((edge) => ({ id: `${edge.source}->${edge.target}`, ...edge })),
    },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
    },
  }
}

/** Stub executors that record every call, in the order the page saw them. */
function recorder(behaviour: Record<string, string> = {}) {
  const calls: { blockId: string; data: Record<string, unknown> }[] = []
  const executors: Record<string, BlockExecutor> = {}
  for (const blockId of ['event-click', 'forms', 'delay', 'new-tab', 'conditions']) {
    executors[blockId] = async (data, ctx) => {
      calls.push({ blockId, data })
      if (blockId === 'forms') ctx.variables['keyword'] = '小红书'
      const failure = behaviour[blockId]
      if (failure) throw new Error(failure)
      return null
    }
  }
  return { calls, executors }
}

describe('running a group', () => {
  it('runs the children in order, then leaves through the group out-edge', async () => {
    const { calls, executors } = recorder()
    const result = await runWorkflow(
      workflow(
        [
          group([child('event-click', 'c1', { selector: '#a' }), child('delay', 'c2')]),
          node('after', 'new-tab'),
        ],
        [{ source: 'g', target: 'after' }],
      ),
      { executors },
    )

    expect(result.outcome).toBe('ok')
    expect(calls.map((call) => call.blockId)).toEqual(['event-click', 'delay', 'new-tab'])
    // Children are not nodes: the completed list keeps only graph ids.
    expect(result.completedNodeIds).toEqual(['g', 'after'])
  })

  it('treats an empty group as a pass-through', async () => {
    const { calls, executors } = recorder()
    const result = await runWorkflow(
      workflow([group([]), node('after', 'new-tab')], [{ source: 'g', target: 'after' }]),
      { executors },
    )
    expect(result.outcome).toBe('ok')
    expect(calls.map((call) => call.blockId)).toEqual(['new-tab'])
  })

  it('interpolates each child against the variables the run shares', async () => {
    const { calls, executors } = recorder()
    const result = await runWorkflow(
      workflow(
        [
          group([
            child('forms', 'c1', { selector: '#search' }),
            child('event-click', 'c2', { selector: '{{keyword}} .row' }),
          ]),
          node('after', 'delay', { time: '{{keyword}}' }),
        ],
        [{ source: 'g', target: 'after' }],
      ),
      { executors },
    )

    expect(result.outcome).toBe('ok')
    // The producer inside the group is visible to its sibling and to the graph.
    expect(calls[1]!.data['selector']).toBe('小红书 .row')
    expect(calls[2]!.data['time']).toBe('小红书')
  })

  it('skips a disabled child and keeps the chain', async () => {
    const { calls, executors } = recorder()
    const result = await runWorkflow(
      workflow(
        [
          group([
            child('event-click', 'c1', { disableBlock: true }),
            child('forms', 'c2'),
            child('delay', 'c3', { disableBlock: true }),
            child('new-tab', 'c4'),
          ]),
        ],
        [],
      ),
      { executors },
    )
    expect(result.outcome).toBe('ok')
    expect(calls.map((call) => call.blockId)).toEqual(['forms', 'new-tab'])
  })

  it('fails the run on a child failure, naming the step inside the group', async () => {
    const { calls, executors } = recorder({ 'event-click': '元素不存在' })
    const result = await runWorkflow(
      workflow(
        [
          group([child('event-click', 'c1', { selector: '#gone' }), child('forms', 'c2')]),
          node('after', 'delay'),
        ],
        [{ source: 'g', target: 'after' }],
      ),
      { executors },
    )

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('元素不存在')
    expect(calls.map((call) => call.blockId)).toEqual(['event-click'])
    const lines = (result.steps ?? []).map((line) => line.text)
    expect((result.steps ?? []).some((line) => line.nodeId === 'g#1')).toBe(true)
    expect(lines.length).toBeGreaterThan(0)
    // Nothing after the failed child ran, and the group did not fall through.
    expect(result.completedNodeIds).not.toContain('after')
  })

  it('refuses a child a linear chain cannot hold instead of skipping it', async () => {
    for (const [blockId, expected] of [
      ['conditions', '不能放进分组'],
      ['not-a-block', '未知算子'],
    ] as const) {
      const { calls, executors } = recorder()
      const result = await runWorkflow(
        workflow(
          [group([child(blockId, 'c1'), child('delay', 'c2')]), node('after', 'new-tab')],
          [{ source: 'g', target: 'after' }],
        ),
        { executors },
      )
      expect(result.outcome, blockId).toBe('failed')
      expect(result.error, blockId).toContain(expected)
      expect(calls, blockId).toEqual([])
    }
  })

  it('never registers a child over a real graph node', async () => {
    // The child keys are `<group id>#<position>`; a graph node already using one
    // must not be shadowed and then dropped from the maps.
    const { calls, executors } = recorder()
    const result = await runWorkflow(
      workflow(
        [group([child('event-click', 'c1')]), node('g#1', 'delay')],
        [{ source: 'g', target: 'g#1' }],
      ),
      { executors },
    )
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('冲突')
    expect(calls).toEqual([])
  })

  it('runs a group again on every iteration it sits in a loop body', async () => {
    const { calls, executors } = recorder()
    const result = await runWorkflow(
      workflow(
        [node('loop', 'repeat-task', { count: 2 }), group([child('event-click', 'c1')], 'body')],
        [
          { source: 'loop', target: 'body', sourceHandle: 'loop' },
          // The body returns to its loop; that is what ends one iteration.
          { source: 'body', target: 'loop' },
        ],
      ),
      { executors },
    )
    expect(result.outcome).toBe('ok')
    expect(calls.map((call) => call.blockId)).toEqual(['event-click', 'event-click'])
  })
})
