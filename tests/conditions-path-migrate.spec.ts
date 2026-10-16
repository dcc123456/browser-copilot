/**
 * Migration: a legacy `conditions` block (one boolean over a flat tree, wired to
 * output-1/output-2) becomes the N-path shape — one named path holding the legacy
 * tree plus the fallback — with its edges re-pointed.
 */
import { describe, expect, it } from 'vitest'
import { migrateWorkflow } from '../src/lib/workflow/migrate'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

function conditionsWorkflow(nodeData: Record<string, unknown>, edges: WorkflowEdge[]): Workflow {
  const nodes: WorkflowNode[] = [
    {
      id: 'c1',
      label: '条件分支',
      position: { x: 0, y: 0 },
      data: { blockId: 'conditions', ...nodeData } as WorkflowNode['data'],
    },
    {
      id: 'n1',
      label: 'True 分支',
      position: { x: 200, y: 0 },
      data: { blockId: 'delay' } as WorkflowNode['data'],
    },
    {
      id: 'n2',
      label: 'False 分支',
      position: { x: 200, y: 120 },
      data: { blockId: 'delay' } as WorkflowNode['data'],
    },
  ]
  return {
    id: 'w1',
    name: 'Legacy conditions',
    createdAt: 1,
    updatedAt: 1,
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: { nodes, edges },
  }
}

const legacyGroup = { id: 'g1', conditions: [{ id: 'r1', items: [] }] }

describe('migrateWorkflow · conditions block to N paths', () => {
  it('synthesizes one path carrying the legacy tree and remaps true/false edges', () => {
    const out = migrateWorkflow(
      conditionsWorkflow({ conditions: [legacyGroup] }, [
        { id: 'e1', source: 'c1', target: 'n1', sourceHandle: 'conditions-output-1' },
        { id: 'e2', source: 'c1', target: 'n2', sourceHandle: 'conditions-output-2' },
      ]),
    )
    const paths = out.drawflow.nodes[0]!.data['paths'] as {
      id: string
      name: string
      conditions: unknown
    }[]
    expect(paths).toHaveLength(1)
    expect(paths[0]!.id).toBe('p1')
    expect(paths[0]!.name).toBe('Path 1')
    // The single path holds the legacy condition tree.
    expect(paths[0]!.conditions).toEqual([legacyGroup])

    const byId = Object.fromEntries(out.drawflow.edges.map((e) => [e.id, e.sourceHandle]))
    // true edge -> the path handle; false edge -> fallback.
    expect(byId.e1).toBe('conditions-output-p1')
    expect(byId.e2).toBe('conditions-output-none')
  })

  it('is idempotent — a block that already has paths is left untouched', () => {
    const existing = [
      { id: 'keepA', name: 'A', conditions: [legacyGroup] },
      { id: 'keepB', name: 'B', conditions: [] },
    ]
    const wf = conditionsWorkflow({ paths: existing, conditions: [legacyGroup] }, [
      { id: 'e1', source: 'c1', target: 'n1', sourceHandle: 'conditions-output-keepA' },
    ])
    const out = migrateWorkflow(wf)
    expect(out.drawflow.nodes[0]!.data['paths']).toEqual(existing)
    expect(out.drawflow.edges[0]!.sourceHandle).toBe('conditions-output-keepA')
  })

  it('handles a block with no legacy tree by giving it one empty path', () => {
    const out = migrateWorkflow(conditionsWorkflow({}, []))
    const paths = out.drawflow.nodes[0]!.data['paths'] as { id: string; conditions: unknown }[]
    expect(paths).toHaveLength(1)
    expect(paths[0]!.conditions).toEqual([])
  })

  it('leaves non-conditions blocks alone', () => {
    const wf: Workflow = {
      id: 'w2',
      name: 'Plain',
      createdAt: 1,
      updatedAt: 1,
      settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
      drawflow: {
        nodes: [
          {
            id: 'd1',
            label: '延时',
            position: { x: 0, y: 0 },
            data: { blockId: 'delay' } as WorkflowNode['data'],
          },
        ],
        edges: [],
      },
    }
    const out = migrateWorkflow(wf)
    expect(out.drawflow.nodes[0]!.data['paths']).toBeUndefined()
  })
})
