import { describe, it, expect } from 'vitest'
import { flowsToWorkflow, type RecordedFlow } from '../src/lib/workflow/record-convert'

describe('recorder forms blocks', () => {
  it('keeps typed text-field blocks with selector and value', () => {
    const flows: RecordedFlow[] = [
      {
        id: 'a',
        data: {
          blockId: 'forms',
          selector: 'input[name=q]',
          findBy: 'cssSelector',
          type: 'text-field',
          value: 'hello',
          clearValue: true,
          waitForSelector: true,
          waitSelectorTimeout: 5000,
        },
      },
    ]
    const wf = flowsToWorkflow(flows)
    const formsNode = wf.drawflow.nodes.find((n) => n.data.blockId === 'forms')
    expect(formsNode).toBeDefined()
    expect(formsNode!.data['type']).toBe('text-field')
    expect(formsNode!.data['value']).toBe('hello')
    expect(formsNode!.data['selector']).toBe('input[name=q]')
    // edges keyed by block id
    expect(wf.drawflow.edges[0]!.targetHandle).toBe('forms-input-1')
  })

  it('records navigation blocks with waitTabLoaded (wait for load)', () => {
    const flows: RecordedFlow[] = [
      {
        id: 'n',
        data: { blockId: 'new-tab', url: 'https://x.com', waitTabLoaded: true },
      },
    ]
    const wf = flowsToWorkflow(flows)
    const nav = wf.drawflow.nodes.find((n) => n.data.blockId === 'new-tab')
    expect(nav?.data['waitTabLoaded']).toBe(true)
  })
})
