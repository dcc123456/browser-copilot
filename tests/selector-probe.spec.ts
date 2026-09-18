import { describe, expect, it } from 'vitest'
import {
  failingProbes,
  selectorsOf,
  statusOf,
  type SelectorProbeResult,
} from '../src/lib/workflow/selector-probe'
import type { Workflow } from '../src/lib/workflow/types'

function workflowOf(nodes: { id: string; blockId: string; selector?: string }[]): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    drawflow: {
      nodes: nodes.map((node) => ({
        id: node.id,
        label: node.blockId,
        position: { x: 0, y: 0 },
        data: {
          blockId: node.blockId,
          ...(node.selector === undefined ? {} : { selector: node.selector }),
        },
      })),
      edges: [],
      position: { x: 0, y: 0 },
      zoom: 1,
    },
    trigger: { type: 'manual', enabled: true },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
  }
}

function probe(over: Partial<SelectorProbeResult>): SelectorProbeResult {
  return {
    nodeId: 'n1',
    blockId: 'event-click',
    selector: '#go',
    matches: 1,
    status: 'unique',
    ...over,
  }
}

describe('statusOf', () => {
  it('treats exactly one match as the only good answer', () => {
    expect(statusOf(1)).toBe('unique')
  })

  it('flags zero matches as missing — the step would do nothing', () => {
    expect(statusOf(0)).toBe('missing')
  })

  it('flags an invalid selector as missing too', () => {
    // `querySelectorAll` throws on a malformed selector and the injected
    // counter reports -1.
    expect(statusOf(-1)).toBe('missing')
  })

  it('flags several matches as ambiguous — the executor may pick the wrong one', () => {
    expect(statusOf(2)).toBe('ambiguous')
    expect(statusOf(37)).toBe('ambiguous')
  })
})

describe('selectorsOf', () => {
  it('collects only nodes that carry a selector', () => {
    const found = selectorsOf(
      workflowOf([
        { id: 't', blockId: 'trigger' },
        { id: 'a', blockId: 'event-click', selector: '#go' },
        { id: 'b', blockId: 'delay' },
        { id: 'c', blockId: 'forms', selector: '#q' },
      ]),
    )

    expect(found.map((entry) => entry.nodeId)).toEqual(['a', 'c'])
  })

  it('skips the trigger even if it somehow carries a selector', () => {
    // The trigger is not a page step; probing it would report a false failure.
    const found = selectorsOf(workflowOf([{ id: 't', blockId: 'trigger', selector: '#x' }]))
    expect(found).toEqual([])
  })

  it('ignores blank selectors instead of reporting them as missing', () => {
    const found = selectorsOf(
      workflowOf([
        { id: 'a', blockId: 'event-click', selector: '   ' },
        { id: 'b', blockId: 'event-click', selector: '' },
      ]),
    )
    expect(found).toEqual([])
  })

  it('trims the selector it reports', () => {
    const found = selectorsOf(workflowOf([{ id: 'a', blockId: 'event-click', selector: ' #go ' }]))
    expect(found[0]!.selector).toBe('#go')
  })
})

describe('failingProbes', () => {
  it('keeps only what the user has to act on', () => {
    const failing = failingProbes([
      probe({ nodeId: 'ok' }),
      probe({ nodeId: 'gone', status: 'missing', matches: 0 }),
      probe({ nodeId: 'wide', status: 'ambiguous', matches: 4 }),
    ])

    expect(failing.map((entry) => entry.nodeId)).toEqual(['gone', 'wide'])
  })

  it('returns nothing when every selector is unique', () => {
    expect(failingProbes([probe({}), probe({ nodeId: 'n2' })])).toEqual([])
  })
})
