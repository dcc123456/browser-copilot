import { describe, expect, it } from 'vitest'
import { runWorkflow, type WorkflowRunOptions } from '../src/background/workflow-engine/engine'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

function node(id: string, blockId: string, data: Record<string, unknown> = {}): WorkflowNode {
  return { id, label: blockId, position: { x: 0, y: 0 }, data: { blockId, ...data } }
}

function graph(nodes: WorkflowNode[], edges: { source: string; target: string }[] = []): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: {
      nodes,
      edges: edges.map((edge, index) => ({ id: `e${index}`, ...edge })),
    },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
    },
  }
}

function executors(order: string[]) {
  return {
    trigger: async () => {
      order.push('exec:trigger')
      return null
    },
    'get-text': async () => {
      order.push('exec:get-text')
      return null
    },
    'set-variable': async (
      _data: Record<string, unknown>,
      ctx: { variables: Record<string, unknown> },
    ) => {
      order.push('exec:set-variable')
      ctx.variables['done'] = true
      return null
    },
  }
}

describe('the onBeforeNode debug hook', () => {
  it('runs once, before the executor, and reports the breakpoint flag', async () => {
    const order: string[] = []
    const result = await runWorkflow(graph([node('a', 'get-text', { $breakpoint: true })]), {
      executors: executors(order),
      onBeforeNode: (info) => {
        order.push(`hook:${info.nodeId}:${info.breakpoint}`)
      },
    })
    expect(order).toEqual(['hook:a:true', 'exec:get-text'])
    expect(result.outcome).toBe('ok')
  })

  it('does not pause on a disabled node', async () => {
    const order: string[] = []
    const hooked: string[] = []
    await runWorkflow(
      graph(
        [node('a', 'get-text', { disableBlock: true, $breakpoint: true }), node('b', 'get-text')],
        [{ source: 'a', target: 'b' }],
      ),
      {
        executors: executors(order),
        onBeforeNode: (info) => {
          hooked.push(info.nodeId)
        },
      },
    )
    expect(hooked).toEqual(['b'])
    expect(order).toEqual(['exec:get-text'])
  })

  it('does not pause on a node the preflight gate blocks', async () => {
    const hooked: string[] = []
    const result = await runWorkflow(graph([node('a', 'get-text', { $breakpoint: true })]), {
      executors: executors([]),
      preflightBlockers: { a: '缺少元素定位' },
      onBeforeNode: (info) => {
        hooked.push(info.nodeId)
      },
    })
    expect(hooked).toEqual([])
    expect(result.outcome).toBe('failed')
  })

  it('cancels the run when the signal aborts while the hook is held', async () => {
    const controller = new AbortController()
    let releaseHook!: () => void
    const hookStarted = new Promise<void>((resolve) => {
      releaseHook = resolve
    })
    const running = runWorkflow(graph([node('a', 'get-text')]), {
      executors: executors([]),
      signal: controller.signal,
      onBeforeNode: () => {
        releaseHook()
        return new Promise<void>(() => {})
      },
    })
    await hookStarted
    controller.abort()
    const result = await running
    expect(result.outcome).toBe('cancelled')
  })

  it('forwards the hook into execute-workflow children', async () => {
    const child = graph(
      [node('ct', 'trigger'), node('cs1', 'get-text', { $breakpoint: true })],
      [{ source: 'ct', target: 'cs1' }],
    )
    const parent = graph(
      [
        node('t', 'trigger'),
        node('sub', 'execute-workflow', { values: { workflowId: 'child' } }),
        node('done', 'set-variable', { variableName: 'done', value: 'yes' }),
      ],
      [
        { source: 't', target: 'sub' },
        { source: 'sub', target: 'done' },
      ],
    )
    const hooked: string[] = []
    const options: WorkflowRunOptions = {
      executors: executors([]),
      resolveWorkflow: async (id) => (id === 'child' ? child : null),
      onBeforeNode: (info) => {
        hooked.push(info.nodeId)
      },
    }
    const result = await runWorkflow(parent, options)
    expect(result.outcome).toBe('ok')
    expect(hooked).toEqual(['t', 'sub', 'ct', 'cs1', 'done'])
    expect(hooked.filter((id) => id === 'cs1')).toHaveLength(1)
  })

  it('leaves a run without the hook behaving exactly as before', async () => {
    const order: string[] = []
    const result = await runWorkflow(graph([node('a', 'get-text')]), {
      executors: executors(order),
    })
    expect(order).toEqual(['exec:get-text'])
    expect(result.outcome).toBe('ok')
  })
})
