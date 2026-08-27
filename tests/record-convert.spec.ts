/**
 * flowsToWorkflow: recorded events become a trigger-first linear graph.
 */
import { describe, it, expect } from 'vitest'
import { flowsToWorkflow, type RecordedFlow } from '../src/lib/workflow/record-convert'

const flows: RecordedFlow[] = [
  { id: 'f1', data: { blockId: 'new-tab', url: 'https://example.com' } },
  {
    id: 'f2',
    description: 'Click login',
    data: { blockId: 'event-click', selector: '#login', findBy: 'cssSelector' },
  },
  { id: 'f3', data: { blockId: 'forms', selector: 'input[name=q]', value: 'hi' } },
]

describe('flowsToWorkflow', () => {
  it('prepends a manual trigger node', () => {
    const wf = flowsToWorkflow(flows)
    expect(wf.drawflow.nodes[0]!.data.blockId).toBe('trigger')
    expect(wf.drawflow.nodes[0]!.data.type).toBe('manual')
  })

  it('creates one node per recorded flow with preserved data', () => {
    const wf = flowsToWorkflow(flows)
    // trigger + 3 flows
    expect(wf.drawflow.nodes).toHaveLength(4)
    const click = wf.drawflow.nodes.find((n) => n.data.blockId === 'event-click')
    expect(click?.data.selector).toBe('#login')
    expect(click?.data.description).toBe('Click login')
  })

  it('wires every node sequentially with output-1 -> input-1 handles', () => {
    const wf = flowsToWorkflow(flows)
    expect(wf.drawflow.edges).toHaveLength(3)
    const ids = wf.drawflow.nodes.map((n) => n.id)
    expect(wf.drawflow.edges[0]!.source).toBe(ids[0])
    expect(wf.drawflow.edges[0]!.target).toBe(ids[1])
    // chain is continuous
    for (let i = 1; i < wf.drawflow.edges.length; i++) {
      expect(wf.drawflow.edges[i]!.source).toBe(wf.drawflow.edges[i - 1]!.target)
    }
  })

  it('keys edge handles by BLOCK id so React Flow resolves them', () => {
    const wf = flowsToWorkflow(flows)
    // trigger -> new-tab
    expect(wf.drawflow.edges[0]!.sourceHandle).toBe('trigger-output-1')
    expect(wf.drawflow.edges[0]!.targetHandle).toBe('new-tab-input-1')
    // new-tab -> event-click
    expect(wf.drawflow.edges[1]!.sourceHandle).toBe('new-tab-output-1')
    expect(wf.drawflow.edges[1]!.targetHandle).toBe('event-click-input-1')
    // event-click -> forms
    expect(wf.drawflow.edges[2]!.sourceHandle).toBe('event-click-output-1')
    expect(wf.drawflow.edges[2]!.targetHandle).toBe('forms-input-1')
  })

  it('lays nodes out left-to-right with increasing x', () => {
    const wf = flowsToWorkflow(flows)
    const xs = wf.drawflow.nodes.map((n) => n.position.x)
    for (let i = 1; i < xs.length; i++) expect(xs[i]! > xs[i - 1]!).toBe(true)
  })

  it('works with an empty recording (trigger only)', () => {
    const wf = flowsToWorkflow([])
    expect(wf.drawflow.nodes).toHaveLength(1)
    expect(wf.drawflow.edges).toHaveLength(0)
    expect(wf.trigger?.type).toBe('manual')
  })

  it('uses the provided name', () => {
    expect(flowsToWorkflow(flows, { name: 'My rec' }).name).toBe('My rec')
  })
})
