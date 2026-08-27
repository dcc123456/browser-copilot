import { describe, it, expect } from 'vitest'
import { migrateWorkflow } from '../src/lib/workflow/migrate'
import type { Workflow } from '../src/lib/workflow/types'

function wfWithEdges(
  edges: { id: string; source: string; target: string; sourceHandle?: string; targetHandle?: string }[],
): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: {
      position: { x: 0, y: 0 },
      zoom: 1,
      nodes: [
        { id: 'n1', label: 'Trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger', type: 'manual' } },
        { id: 'n2', label: 'Click', position: { x: 1, y: 0 }, data: { blockId: 'event-click', selector: 'a' } },
        { id: 'n3', label: 'Forms', position: { x: 2, y: 0 }, data: { blockId: 'forms', selector: 'input' } },
      ],
      edges: edges as never,
    },
  }
}

describe('migrateWorkflow edge handle normalization', () => {
  it('fixes early recorder edges keyed by NODE id', () => {
    const wf = wfWithEdges([
      { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'n1-output-1', targetHandle: 'n2-input-1' },
      { id: 'e2', source: 'n2', target: 'n3', sourceHandle: 'n2-output-1', targetHandle: 'n3-input-1' },
    ])
    const out = migrateWorkflow(wf)
    expect(out.drawflow.edges[0]!.sourceHandle).toBe('trigger-output-1')
    expect(out.drawflow.edges[0]!.targetHandle).toBe('event-click-input-1')
    expect(out.drawflow.edges[1]!.sourceHandle).toBe('event-click-output-1')
    expect(out.drawflow.edges[1]!.targetHandle).toBe('forms-input-1')
  })

  it('fixes bare Automa export handles', () => {
    const wf = wfWithEdges([
      { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'output-1', targetHandle: 'input-1' },
    ])
    const out = migrateWorkflow(wf)
    expect(out.drawflow.edges[0]!.sourceHandle).toBe('trigger-output-1')
    expect(out.drawflow.edges[0]!.targetHandle).toBe('event-click-input-1')
  })

  it('leaves already-correct block-id handles unchanged', () => {
    const wf = wfWithEdges([
      { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'trigger-output-1', targetHandle: 'event-click-input-1' },
    ])
    const out = migrateWorkflow(wf)
    expect(out.drawflow.edges[0]!.sourceHandle).toBe('trigger-output-1')
    expect(out.drawflow.edges[0]!.targetHandle).toBe('event-click-input-1')
  })
})
