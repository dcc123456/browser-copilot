/**
 * "Run this block only" is a deliberate partial run: the requested node settles
 * through the ordinary engine path and the walk stops there, never following
 * its out-edges. These tests pin that no downstream executor fires and that a
 * failure on the node is reported as the run's failure.
 *
 * See specs/2026-11-25-run-current-node-design.md.
 */
import { describe, expect, it } from 'vitest'
import { runWorkflow } from '../src/background/workflow-engine/engine'
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

function threeStepGraph(): Workflow {
  return graph(
    [node('a', 'get-text'), node('b', 'event-click'), node('c', 'get-text')],
    [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ],
  )
}

function executors(order: string[], failOn?: string) {
  const record = (id: string) => async () => {
    order.push(id)
    if (failOn === id) throw new Error(`boom in ${id}`)
    return null
  }
  return {
    'get-text': record('get-text'),
    'event-click': record('event-click'),
  }
}

describe('run only the requested node', () => {
  it('executes the node and does not follow its out-edge', async () => {
    const order: string[] = []
    const result = await runWorkflow(threeStepGraph(), {
      startAt: 'b',
      onlyNode: true,
      executors: executors(order),
    })
    expect(order).toEqual(['event-click'])
    expect(result.outcome).toBe('ok')
    expect(result.completedNodeIds).toEqual(['b'])
  })

  it('still runs everything downstream when the flag is absent', async () => {
    const order: string[] = []
    const result = await runWorkflow(threeStepGraph(), {
      startAt: 'b',
      executors: executors(order),
    })
    expect(order).toEqual(['event-click', 'get-text'])
    expect(result.outcome).toBe('ok')
    expect(result.completedNodeIds).toEqual(['b', 'c'])
  })

  it('reports the node failure and never reaches the next node', async () => {
    const order: string[] = []
    const result = await runWorkflow(threeStepGraph(), {
      startAt: 'b',
      onlyNode: true,
      executors: executors(order, 'event-click'),
    })
    expect(order).toEqual(['event-click'])
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('boom in event-click')
  })

  it('stops at the node it started from even when that node is the trigger', async () => {
    const order: string[] = []
    const result = await runWorkflow(threeStepGraph(), {
      startAt: 'a',
      onlyNode: true,
      executors: executors(order),
    })
    expect(order).toEqual(['get-text'])
    expect(result.outcome).toBe('ok')
    expect(result.completedNodeIds).toEqual(['a'])
  })
})
