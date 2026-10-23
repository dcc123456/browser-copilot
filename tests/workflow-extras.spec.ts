import { describe, expect, it } from 'vitest'
import { readEdgeStyle, workflowEdgeOf } from '../src/lib/workflow/edge-data'
import { migrateWorkflow } from '../src/lib/workflow/migrate'
import type { Workflow, WorkflowEdge } from '../src/lib/workflow/types'

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'w1',
    name: 'extras',
    createdAt: 0,
    updatedAt: 0,
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    drawflow: {
      nodes: [
        {
          id: 't',
          label: 'trigger',
          position: { x: 0, y: 0 },
          data: { blockId: 'trigger', type: 'manual' },
        },
        {
          id: 'a',
          label: 'Click',
          position: { x: 200, y: 0 },
          data: {
            blockId: 'event-click',
            selector: '#x',
            $breakpoint: true,
            blockTimeout: 2000,
          },
        },
      ],
      edges: [{ id: 'e1', source: 't', target: 'a' }],
    },
    ...overrides,
  }
}

/** What the editor does when it turns a persisted edge into a canvas edge. */
function canvasEdgeOf(edge: WorkflowEdge) {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
    data: readEdgeStyle(edge),
  }
}

describe('connection style round-trip', () => {
  it('reads the three fields off a persisted edge', () => {
    expect(
      readEdgeStyle({ label: 'retry', animated: true, color: '#ff8800', source: 't' }),
    ).toEqual({ label: 'retry', animated: true, color: '#ff8800' })
  })

  it('reads them off React Flow edge data too', () => {
    expect(readEdgeStyle({ label: 'retry', animated: true, color: '#ff8800' })).toEqual({
      label: 'retry',
      animated: true,
      color: '#ff8800',
    })
  })

  it('drops empty or mistyped style values', () => {
    expect(readEdgeStyle({ label: '', animated: 'yes', color: '' })).toEqual({})
    expect(readEdgeStyle(null)).toEqual({})
  })

  it('keeps runtime-only flags out of the saved file', () => {
    const edge = workflowEdgeOf({
      id: 'e1',
      source: 't',
      target: 'a',
      data: { highlighted: true, loopBack: true, arrow: false, label: 'again' },
    })
    expect(edge).toEqual({
      id: 'e1',
      source: 't',
      target: 'a',
      sourceHandle: undefined,
      targetHandle: undefined,
      label: 'again',
    })
  })

  it('round-trips a persisted edge through the canvas shape', () => {
    const persisted: WorkflowEdge = {
      id: 'e1',
      source: 't',
      target: 'a',
      sourceHandle: 'trigger-output-1',
      targetHandle: 'event-click-input-1',
      label: 'retry',
      animated: true,
      color: '#ff8800',
    }
    expect(workflowEdgeOf(canvasEdgeOf(persisted))).toEqual(persisted)
  })

  it('maps React Flow null handles to absent file fields', () => {
    const edge = workflowEdgeOf({
      id: 'e1',
      source: 't',
      target: 'a',
      sourceHandle: null,
      targetHandle: null,
    })
    expect(edge.sourceHandle).toBeUndefined()
    expect(edge.targetHandle).toBeUndefined()
  })
})

describe('block extras survive load → save', () => {
  it('keeps $breakpoint, blockTimeout and edge styling through migration', () => {
    const saved = workflow({
      drawflow: {
        nodes: [
          {
            id: 't',
            label: 'trigger',
            position: { x: 0, y: 0 },
            data: { blockId: 'trigger', type: 'manual' },
          },
          {
            id: 'a',
            label: 'Click',
            position: { x: 200, y: 0 },
            data: {
              blockId: 'event-click',
              selector: '#x',
              $breakpoint: true,
              blockTimeout: 2000,
            },
          },
        ],
        edges: [
          {
            id: 'e1',
            source: 't',
            target: 'a',
            // Legacy bare handles force a real migration pass.
            sourceHandle: 'output-1',
            targetHandle: 'input-1',
            label: 'retry',
            animated: true,
            color: '#ff8800',
          },
        ],
      },
    })

    const loaded = migrateWorkflow(JSON.parse(JSON.stringify(saved)) as Workflow)
    const click = loaded.drawflow.nodes.find((node) => node.id === 'a')!
    expect(click.data['$breakpoint']).toBe(true)
    expect(click.data['blockTimeout']).toBe(2000)

    const loadedEdge = loaded.drawflow.edges[0]!
    expect(loadedEdge.sourceHandle).toBe('trigger-output-1')
    expect(loadedEdge).toMatchObject({ label: 'retry', animated: true, color: '#ff8800' })

    // Save converts canvas edges back; nothing the Lines tab wrote may drop.
    expect(workflowEdgeOf(canvasEdgeOf(loadedEdge))).toEqual(loadedEdge)
  })
})
