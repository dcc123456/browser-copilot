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

  it('de-duplicates repeated text-field fill blocks for the same field and value', () => {
    // One physical fill reaches the recorder through input-debounce, Enter,
    // blur and change — up to four identical `forms` flows. Only one node must
    // survive, while a genuinely different value is kept.
    const flows: RecordedFlow[] = [
      {
        id: 'f1',
        data: { blockId: 'forms', selector: 'input[name=q]', findBy: 'cssSelector', type: 'text-field', value: 'abc' },
      },
      {
        id: 'f2',
        data: { blockId: 'forms', selector: 'input[name=q]', findBy: 'cssSelector', type: 'text-field', value: 'abc' },
      },
      {
        id: 'f3',
        data: { blockId: 'forms', selector: 'input[name=q]', findBy: 'cssSelector', type: 'text-field', value: 'abc' },
      },
      {
        id: 'f4',
        data: { blockId: 'forms', selector: 'input[name=other]', findBy: 'cssSelector', type: 'text-field', value: 'xyz' },
      },
    ]
    const wf = flowsToWorkflow(flows)
    const formsNodes = wf.drawflow.nodes.filter((n) => n.data.blockId === 'forms')
    // trigger + 2 distinct fills (the three identical 'abc' fills collapse to 1)
    expect(formsNodes).toHaveLength(2)
    expect(formsNodes.map((n) => n.data['value'])).toEqual(['abc', 'xyz'])
    // The chain still links trigger -> first fill -> second fill (no dangling
    // edge pointing at a removed duplicate).
    expect(wf.drawflow.edges).toHaveLength(2)
  })
})
