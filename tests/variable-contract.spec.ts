/**
 * Variable contract extension tests (spec §5.3 · P2).
 *
 * Covers the four distinctions §5.3 requires (missing / empty / wrong type /
 * length & pattern), the "no contract ⇒ unknown, never a blocker" boundary,
 * and deriving contracts from explicit metadata vs block semantics.
 */
import { describe, expect, it } from 'vitest'

import {
  contractOfNode,
  contractsForWorkflow,
  defaultContractOfNode,
  evaluateContract,
  explicitContractOf,
  valueTypeOf,
} from '../src/lib/workflow/variable-contract'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

const node = (id: string, data: Record<string, unknown>): WorkflowNode => ({
  id,
  label: String(data['blockId'] ?? id),
  position: { x: 0, y: 0 },
  data,
})

const workflow = (nodes: WorkflowNode[]): Workflow => ({
  id: 'wf',
  name: 'wf',
  description: '',
  createdAt: 0,
  updatedAt: 0,
  drawflow: { nodes, edges: [] },
  settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
})

describe('evaluateContract', () => {
  it('flags a variable that was never produced as MISSING', () => {
    const result = evaluateContract(undefined, { required: true }, { produced: false })
    expect(result.state).toBe('MISSING')
    expect(result.valid).toBe(false)
    expect(result.unknown).toBe(false)
  })

  it('flags an empty value as EMPTY unless allowEmpty', () => {
    expect(evaluateContract('', { required: true }).state).toBe('EMPTY')
    const allowed = evaluateContract('', { required: true, allowEmpty: true })
    expect(allowed.state).toBe('ok')
    expect(allowed.valid).toBe(true)
  })

  it('distinguishes a wrong type', () => {
    expect(evaluateContract(123, { type: 'string' }).state).toBe('TYPE')
    expect(evaluateContract('x', { type: 'number' }).state).toBe('TYPE')
    expect(evaluateContract(['a'], { type: 'array' }).state).toBe('ok')
  })

  it('enforces minLength and pattern', () => {
    expect(evaluateContract('ab', { minLength: 3 }).state).toBe('LENGTH')
    expect(evaluateContract('abc123', { pattern: '^[a-z]+$' }).state).toBe('PATTERN')
    const ok = evaluateContract('abc', { pattern: '^[a-z]+$' })
    expect(ok.state).toBe('ok')
  })

  it('treats an absent or uncompilable contract as unknown, never a blocker', () => {
    expect(evaluateContract('anything', undefined).unknown).toBe(true)
    const broken = evaluateContract('x', { pattern: '[' })
    expect(broken.unknown).toBe(true)
    expect(broken.valid).toBe(true)
  })
})

describe('valueTypeOf', () => {
  it('maps runtime values to the contract vocabulary', () => {
    expect(valueTypeOf('s')).toBe('string')
    expect(valueTypeOf(1)).toBe('number')
    expect(valueTypeOf(true)).toBe('boolean')
    expect(valueTypeOf([1])).toBe('array')
    expect(valueTypeOf({ a: 1 })).toBe('object')
    expect(valueTypeOf(null)).toBe('null')
  })
})

describe('contract derivation', () => {
  it('reads explicit __contract metadata', () => {
    const n = node('n', {
      blockId: 'get-text',
      variableName: 'code',
      __contract: { type: 'string', minLength: 4 },
    })
    expect(explicitContractOf(n)).toMatchObject({ type: 'string', minLength: 4 })
    // Explicit wins over the default.
    expect(contractOfNode(n)).toMatchObject({ type: 'string', minLength: 4 })
  })

  it('derives a default contract from block semantics', () => {
    expect(
      defaultContractOfNode(node('n', { blockId: 'increase-variable', variableName: 'count' })),
    ).toMatchObject({ type: 'number' })
    expect(
      defaultContractOfNode(node('n', { blockId: 'data-mapping', variableName: 'rows' })),
    ).toMatchObject({ type: 'array', allowEmpty: true })
    expect(
      defaultContractOfNode(node('n', { blockId: 'get-text', variableName: 'text' })),
    ).toMatchObject({ required: true, allowEmpty: false })
    // A node without a produced variable imposes no contract.
    expect(defaultContractOfNode(node('n', { blockId: 'delay' }))).toBeUndefined()
  })

  it('collects one contract per produced variable across the workflow', () => {
    const map = contractsForWorkflow(
      workflow([
        node('a', { blockId: 'get-text', variableName: 'captcha' }),
        node('b', { blockId: 'increase-variable', variableName: 'count' }),
        node('c', { blockId: 'click' }),
      ]),
    )
    expect([...map.keys()].sort()).toEqual(['captcha', 'count'])
  })
})
