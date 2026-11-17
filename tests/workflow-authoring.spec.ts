/**
 * The MCP save_workflow handler: blocking validation refuses the write, while
 * run-level findings are returned as warnings and never block — the same save
 * policy compose_workflow uses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const saveWorkflow = vi.fn().mockResolvedValue(undefined)
vi.mock('../src/lib/storage', () => ({ newId: () => 'w-new' }))
vi.mock('../src/lib/workflow/storage', () => ({
  saveWorkflow: (...args: unknown[]) => saveWorkflow(...args),
}))

import { saveAuthoredWorkflow } from '../src/background/workflow-authoring'

function node(id: string, blockId: string): Record<string, unknown> {
  return { id, label: blockId, position: { x: 0, y: 0 }, data: { blockId } }
}

const graph = {
  name: 'Data only',
  nodes: [node('t1', 'trigger'), node('p1', 'parse-excel'), node('e1', 'export-data')],
  edges: [
    {
      id: 'a',
      source: 't1',
      target: 'p1',
      sourceHandle: 'trigger-output-1',
      targetHandle: 'p1-input-1',
    },
    {
      id: 'b',
      source: 'p1',
      target: 'e1',
      sourceHandle: 'p1-output-1',
      targetHandle: 'e1-input-1',
    },
  ],
}

beforeEach(() => saveWorkflow.mockReset().mockResolvedValue(undefined))

describe('saveAuthoredWorkflow', () => {
  it('persists a valid graph and returns its id', async () => {
    const out = await saveAuthoredWorkflow({ workflow: graph })
    expect(out.ok).toBe(true)
    expect(out.workflowId).toBe('w-new')
    expect(out.nodeCount).toBe(3)
    expect(saveWorkflow).toHaveBeenCalledTimes(1)
    expect(saveWorkflow.mock.calls[0]![0].drawflow.nodes).toHaveLength(3)
  })

  it('dry-run validates without persisting', async () => {
    const out = await saveAuthoredWorkflow({ workflow: graph, save: false })
    expect(out.ok).toBe(true)
    expect(out.workflowId).toBeUndefined()
    expect(saveWorkflow).not.toHaveBeenCalled()
  })

  it('refuses a graph with dangling edges and does not persist', async () => {
    const out = await saveAuthoredWorkflow({
      workflow: { ...graph, edges: [{ id: 'a', source: 't1', target: 'missing' }] },
    })
    expect(out.ok).toBe(false)
    expect(out.errors?.join(' ')).toContain('not a node')
    expect(saveWorkflow).not.toHaveBeenCalled()
  })

  it('requires a name', async () => {
    const out = await saveAuthoredWorkflow({ workflow: { ...graph, name: '  ' } })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('non-empty')
    expect(saveWorkflow).not.toHaveBeenCalled()
  })

  it('refuses a missing or empty node list', async () => {
    const out = await saveAuthoredWorkflow({ workflow: { ...graph, nodes: [] } })
    expect(out.ok).toBe(false)
    expect(out.errors?.join(' ')).toContain('non-empty array')
    expect(saveWorkflow).not.toHaveBeenCalled()
  })

  it('rejects a missing workflow object', async () => {
    expect((await saveAuthoredWorkflow({})).ok).toBe(false)
    expect(saveWorkflow).not.toHaveBeenCalled()
  })
})
