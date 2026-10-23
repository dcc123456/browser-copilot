import { describe, expect, it } from 'vitest'
import { runWorkflow } from '../src/background/workflow-engine/engine'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

function node(id: string, data: Record<string, unknown> = {}): WorkflowNode {
  return { id, label: 'get-text', position: { x: 0, y: 0 }, data: { blockId: 'get-text', ...data } }
}

function graph(nodes: WorkflowNode[]): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes, edges: [] },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
    },
  }
}

describe('blockTimeout', () => {
  it('fails a never-resolving executor with BLOCK_TIMEOUT', async () => {
    const result = await runWorkflow(graph([node('a', { blockTimeout: 20 })]), {
      executors: { 'get-text': () => new Promise(() => {}) },
    })
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('BLOCK_TIMEOUT(20ms)')
  })

  it('gives every retry attempt a fresh timeout', async () => {
    let attempts = 0
    const result = await runWorkflow(
      graph([
        node('a', {
          blockTimeout: 20,
          onError: { enable: true, retry: true, retryTimes: 1, retryInterval: 0, toDo: 'error' },
        }),
      ]),
      {
        executors: {
          'get-text': async () => {
            attempts += 1
            if (attempts === 1) return new Promise<null>(() => {})
            return null
          },
        },
      },
    )
    expect(attempts).toBe(2)
    expect(result.outcome).toBe('ok')
  })

  it('does not change a fast block', async () => {
    const result = await runWorkflow(graph([node('a', { blockTimeout: 5000 })]), {
      executors: { 'get-text': async () => null },
    })
    expect(result.outcome).toBe('ok')
  })

  it('leaves a block without a timeout unbounded by the engine', async () => {
    const result = await runWorkflow(graph([node('a')]), {
      executors: { 'get-text': async () => null },
    })
    expect(result.outcome).toBe('ok')
  })
})
