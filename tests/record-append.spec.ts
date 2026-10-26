/**
 * Appending a recording to the canvas the user is already editing.
 *
 * The recorded workflow always carries its own trigger, and it has to be
 * dropped: the steps belong after whatever is already on the canvas. The only
 * unambiguous continuation point is a single terminal (a node with no outgoing
 * edge) — with zero or several terminals the row is placed to the right and left
 * unconnected rather than guessing which branch to extend.
 */
import { describe, expect, it } from 'vitest'
import { appendRecordedWorkflow, type CanvasGraph } from '../src/lib/workflow/record-append'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

const node = (id: string, blockId: string, x: number, y = 0): WorkflowNode => ({
  id,
  label: blockId,
  position: { x, y },
  data: { blockId },
})

const recorded = (nodes: WorkflowNode[], edges: Workflow['drawflow']['edges'] = []): Workflow => ({
  id: 'recording',
  name: 'Recording',
  createdAt: 0,
  updatedAt: 0,
  drawflow: { nodes, edges },
  settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
})

const graph = (nodes: WorkflowNode[], edges: CanvasGraph['edges'] = []): CanvasGraph => ({
  nodes,
  edges,
})

describe('appendRecordedWorkflow', () => {
  it('drops the recorded trigger, wires after the only terminal and keeps the chain', () => {
    const current = graph(
      [node('trigger', 'trigger', 0), node('click', 'event-click', 240)],
      [{ id: 'e1', source: 'trigger', target: 'click' }],
    )
    const rec = recorded(
      [
        node('r-trigger', 'trigger', 60),
        node('r-fill', 'forms', 260, 180),
        node('r-submit', 'event-click', 460, 180),
      ],
      [
        {
          id: 'rec-edge-1',
          source: 'r-trigger',
          target: 'r-fill',
          sourceHandle: 'trigger-output-1',
          targetHandle: 'forms-input-1',
        },
        {
          id: 'rec-edge-2',
          source: 'r-fill',
          target: 'r-submit',
          sourceHandle: 'forms-output-1',
          targetHandle: 'event-click-input-1',
        },
      ],
    )

    const result = appendRecordedWorkflow(current, rec)

    expect(result.addedNodeIds).toEqual(['r-fill', 'r-submit'])
    expect(result.connectedFrom).toBe('click')
    // The trigger stays behind; only the two recorded steps join the canvas.
    expect(result.nodes.map((n) => n.id)).toEqual(['trigger', 'click', 'r-fill', 'r-submit'])
    // The trigger→step edge is dropped with its source, the inner edge survives.
    expect(result.edges.map((e) => e.id)).not.toContain('rec-edge-1')
    expect(result.edges.map((e) => e.id)).toContain('rec-edge-2')

    const bridge = result.edges.find((e) => e.source === 'click')
    expect(bridge?.target).toBe('r-fill')
    expect(bridge?.sourceHandle).toBe('event-click-output-1')
    expect(bridge?.targetHandle).toBe('forms-input-1')

    // The first step lands one gap right of the terminal, preserving the
    // recorded row's relative offsets.
    const first = result.nodes.find((n) => n.id === 'r-fill')!
    const second = result.nodes.find((n) => n.id === 'r-submit')!
    expect(first.position.x).toBe(240 + 240)
    expect(first.position.y).toBe(0)
    expect(second.position.x - first.position.x).toBe(200)
  })

  it('places the row to the right without a bridge when the graph has several terminals', () => {
    const current = graph(
      [node('trigger', 'trigger', 0), node('a', 'event-click', 240), node('b', 'event-click', 240)],
      [{ id: 'e1', source: 'trigger', target: 'a' }],
    )
    const result = appendRecordedWorkflow(
      current,
      recorded([node('r-trigger', 'trigger', 60), node('r-fill', 'forms', 260)]),
    )

    expect(result.connectedFrom).toBeUndefined()
    expect(result.edges).toHaveLength(1)
    expect(result.nodes.find((n) => n.id === 'r-fill')!.position).toEqual({ x: 480, y: 0 })
  })

  it('leaves the canvas untouched when the recording only captured the trigger', () => {
    const current = graph([node('trigger', 'trigger', 0)])
    const result = appendRecordedWorkflow(current, recorded([node('r-trigger', 'trigger', 60)]))

    expect(result.addedNodeIds).toEqual([])
    expect(result.nodes).toBe(current.nodes)
    expect(result.edges).toBe(current.edges)
  })
})
