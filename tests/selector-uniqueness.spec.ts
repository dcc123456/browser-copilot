import { describe, expect, it } from 'vitest'
import {
  filterBySelectorUniqueness,
  selectorSetTargetsOf,
} from '../src/lib/workflow/repair/selector-uniqueness'
import type { WorkflowPatchOperation, WorkflowPatchSet } from '../src/lib/workflow/repair/types'

function op(
  operationId: string,
  nodeId: string,
  kind: WorkflowPatchOperation['kind'],
  path: string,
  after?: unknown,
): WorkflowPatchOperation {
  return { operationId, nodeId, kind, path, after, reason: 'test', evidenceIds: [] }
}

function set(operations: WorkflowPatchOperation[]): WorkflowPatchSet {
  return {
    patchSetId: 'p1',
    analysisId: 'a1',
    operations,
    reason: 'test',
    confidence: 0.9,
    expectedEffect: 'test',
  }
}

describe('selectorSetTargetsOf', () => {
  it('extracts SET_PARAM and REPLACE_TARGET ops that write a selector string', () => {
    const patch = set([
      op('o1', 'n1', 'SET_PARAM', 'selector', '#submit'),
      op('o2', 'n2', 'REPLACE_TARGET', 'selector', '[data-testid="save"]'),
      op('o3', 'n3', 'SET_PARAM', 'node.some.path.selector', '#deep'),
    ])
    expect(selectorSetTargetsOf(patch)).toEqual([
      { operationId: 'o1', nodeId: 'n1', selector: '#submit' },
      { operationId: 'o2', nodeId: 'n2', selector: '[data-testid="save"]' },
      { operationId: 'o3', nodeId: 'n3', selector: '#deep' },
    ])
  })

  it('ignores non-selector paths, empty selectors, non-strings, and other kinds', () => {
    const patch = set([
      op('o1', 'n1', 'SET_PARAM', 'url', 'https://x.test'),
      op('o2', 'n2', 'SET_PARAM', 'selector', '   '),
      op('o3', 'n3', 'SET_PARAM', 'selector', 42),
      op('o4', 'n4', 'REPLACE_INPUT_REF', 'selector', '#x'),
      op('o5', 'n5', 'REMOVE_PARAM', 'selector', undefined),
    ])
    expect(selectorSetTargetsOf(patch)).toEqual([])
  })
})

describe('filterBySelectorUniqueness', () => {
  it('keeps a unique selector (count 1) and rejects nothing', () => {
    const patch = set([op('o1', 'n1', 'SET_PARAM', 'selector', '#only')])
    const { kept, rejected } = filterBySelectorUniqueness(patch, () => 1)
    expect(kept.operations.map((o) => o.operationId)).toEqual(['o1'])
    expect(rejected).toEqual([])
  })

  it('rejects a dead selector (count 0) with matches 0', () => {
    const patch = set([op('o1', 'n1', 'SET_PARAM', 'selector', '#gone')])
    const { kept, rejected } = filterBySelectorUniqueness(patch, () => 0)
    expect(kept.operations).toHaveLength(0)
    expect(rejected).toEqual([{ operationId: 'o1', nodeId: 'n1', selector: '#gone', matches: 0 }])
  })

  it('rejects an ambiguous selector (count > 1) with the live count', () => {
    const patch = set([op('o1', 'n1', 'SET_PARAM', 'selector', '.row')])
    const { kept, rejected } = filterBySelectorUniqueness(patch, () => 7)
    expect(kept.operations).toHaveLength(0)
    expect(rejected).toEqual([{ operationId: 'o1', nodeId: 'n1', selector: '.row', matches: 7 }])
  })

  it('keeps an unverifiable selector (count null) without regressing', () => {
    const patch = set([op('o1', 'n1', 'SET_PARAM', 'selector', '#maybe')])
    const { kept, rejected } = filterBySelectorUniqueness(patch, () => null)
    expect(kept.operations.map((o) => o.operationId)).toEqual(['o1'])
    expect(rejected).toEqual([])
  })

  it('partitions a mixed patch, always keeping non-selector operations', () => {
    const patch = set([
      op('o1', 'n1', 'SET_PARAM', 'selector', '.many'),
      op('o2', 'n2', 'SET_PARAM', 'value', 'hello'),
      op('o3', 'n3', 'SET_PARAM', 'selector', '#one'),
    ])
    const { kept, rejected } = filterBySelectorUniqueness(patch, (sel) =>
      sel === '.many' ? 3 : 1,
    )
    expect(kept.operations.map((o) => o.operationId)).toEqual(['o2', 'o3'])
    expect(rejected.map((r) => r.operationId)).toEqual(['o1'])
  })
})