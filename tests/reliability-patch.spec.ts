/**
 * ReliabilityPatch tests (spec §12/§13, Phase 8): schema + policy validation,
 * confidence gates, single-node application with protected keys, contract
 * tightening only, and the same-failure-same-patch circuit breaker.
 */
import { describe, expect, it } from 'vitest'
import {
  applyReliabilityPatch,
  confidenceGate,
  patchFingerprint,
  PatchCircuitBreaker,
  validateReliabilityPatch,
  type ReliabilityPatch,
} from '../src/lib/workflow/reliability-patch'
import type { Workflow } from '../src/lib/workflow/types'

function tinyWorkflow(): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    description: '',
    trigger: { type: 'manual', enabled: true },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    table: [],
    drawflow: {
      nodes: [
        { id: 'a', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger' } },
        {
          id: 'b',
          label: 'event-click',
          position: { x: 1, y: 0 },
          data: {
            blockId: 'event-click',
            selector: '.stale',
            __reliability: {
              intent: '点击',
              idempotency: 'conditional',
              postconditions: [{ kind: 'elementExists', target: { testId: 'x' } }],
            },
          },
        },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'next', targetHandle: 'input-1' }],
    },
    createdAt: 0,
    updatedAt: 0,
  }
}

function patch(overrides: Partial<ReliabilityPatch> = {}): ReliabilityPatch {
  return {
    nodeId: 'b',
    kind: 'set-locator',
    paramsPatch: { selector: '[data-testid="fresh"]' },
    confidence: 0.85,
    reason: '旧选择器过期，换稳定 testid',
    failureCode: 'LOCATOR_NOT_FOUND',
    ...overrides,
  }
}

describe('validateReliabilityPatch', () => {
  it('accepts a well-formed local patch', () => {
    expect(validateReliabilityPatch(patch(), tinyWorkflow()).ok).toBe(true)
  })

  it('refuses unknown nodes and empty patches', () => {
    const problems = validateReliabilityPatch(patch({ nodeId: 'zzz' }), tinyWorkflow())
    expect(problems.ok).toBe(false)
    expect(problems.problems.join()).toContain('不存在')
    expect(validateReliabilityPatch(patch({ paramsPatch: {} }), tinyWorkflow()).ok).toBe(false)
  })

  it('refuses graph-structure mutations (blockId/disableBlock/id/position)', () => {
    for (const key of ['blockId', 'disableBlock', 'id', 'position']) {
      const result = validateReliabilityPatch(patch({ paramsPatch: { [key]: 'x' } }), tinyWorkflow())
      expect(result.ok).toBe(false)
      expect(result.problems.join()).toContain(key)
    }
  })

  it('refuses confidence out of range and missing reason', () => {
    expect(validateReliabilityPatch(patch({ confidence: 1.2 }), tinyWorkflow()).ok).toBe(false)
    expect(validateReliabilityPatch(patch({ confidence: -0.1 }), tinyWorkflow()).ok).toBe(false)
    expect(validateReliabilityPatch(patch({ reason: '' }), tinyWorkflow()).ok).toBe(false)
  })

  it('refuses idempotency relaxation but allows tightening', () => {
    // Original is `conditional` (rank 1): downgrading to `unsafe` (0) is a
    // relaxation — refused; upgrading to `safe` (2) is a tightening — allowed.
    const relax = patch({
      kind: 'set-contract',
      paramsPatch: { __reliability: { idempotency: 'unsafe' } },
    })
    expect(validateReliabilityPatch(relax, tinyWorkflow()).ok).toBe(false)
    const tighten = patch({
      kind: 'set-contract',
      paramsPatch: { __reliability: { idempotency: 'safe' } },
    })
    expect(validateReliabilityPatch(tighten, tinyWorkflow()).ok).toBe(true)
  })

  it('refuses postcondition removal but allows addition', () => {
    const remove = patch({
      kind: 'set-contract',
      paramsPatch: { __reliability: { postconditions: [] } },
    })
    expect(validateReliabilityPatch(remove, tinyWorkflow()).ok).toBe(false)
    const add = patch({
      kind: 'set-contract',
      paramsPatch: {
        __reliability: {
          postconditions: [
            { kind: 'elementExists', target: { testId: 'x' } },
            { kind: 'urlContains', value: '/done' },
          ],
        },
      },
    })
    expect(validateReliabilityPatch(add, tinyWorkflow()).ok).toBe(true)
  })
})

describe('confidence gate', () => {
  it('refuses below 0.75, verifies in 0.75–0.9, chains above 0.9', () => {
    expect(confidenceGate(patch({ confidence: 0.5 }))).toBe('refuse')
    expect(confidenceGate(patch({ confidence: 0.74 }))).toBe('refuse')
    expect(confidenceGate(patch({ confidence: 0.75 }))).toBe('apply-and-verify')
    expect(confidenceGate(patch({ confidence: 0.89 }))).toBe('apply-and-verify')
    expect(confidenceGate(patch({ confidence: 0.9 }))).toBe('apply-verify-chain')
    expect(confidenceGate(patch({ confidence: 0.99 }))).toBe('apply-verify-chain')
  })
})

describe('applyReliabilityPatch', () => {
  it('applies to exactly one node and records the change', () => {
    const result = applyReliabilityPatch(tinyWorkflow(), patch())
    expect(result.applied).toBe(true)
    expect(result.workflow.drawflow.nodes[1]?.data?.['selector']).toBe('[data-testid="fresh"]')
    expect(result.workflow.drawflow.nodes[0]?.data?.['blockId']).toBe('trigger')
    expect(result.changes.join()).toContain('0.85')
  })

  it('does not mutate the input workflow', () => {
    const wf = tinyWorkflow()
    applyReliabilityPatch(wf, patch())
    expect(wf.drawflow.nodes[1]?.data?.['selector']).toBe('.stale')
  })

  it('refuses invalid patches without touching the graph', () => {
    const result = applyReliabilityPatch(tinyWorkflow(), patch({ paramsPatch: { blockId: 'forms' } }))
    expect(result.applied).toBe(false)
    expect(result.problems?.join()).toContain('blockId')
    expect(result.workflow.drawflow.nodes[1]?.data?.['selector']).toBe('.stale')
  })
})

describe('patch fingerprint + circuit breaker', () => {
  it('identical intent hashes equal; different node/params hash differently', () => {
    const base = patch()
    expect(patchFingerprint(base)).toBe(patchFingerprint(patch()))
    expect(patchFingerprint(base)).not.toBe(patchFingerprint(patch({ nodeId: 'a' })))
    expect(patchFingerprint(base)).not.toBe(
      patchFingerprint(patch({ paramsPatch: { selector: '.other' } })),
    )
  })

  it('refuses the same patch after its failure recurred, allows others', () => {
    const breaker = new PatchCircuitBreaker()
    const base = patch()
    expect(breaker.allows(base)).toBe(true)
    breaker.applied(base)
    // First failure after applying: the patch is now WATCHED, not refused —
    // one attempt with a stated reason is legitimate debugging.
    expect(breaker.observeFailure(base)).toBe(true)
    expect(breaker.allows(base)).toBe(true)
    // The SAME patch failing AGAIN is the loop the breaker exists to stop.
    expect(breaker.observeFailure(base)).toBe(false)
    expect(breaker.allows(base)).toBe(false)
    const different = patch({ paramsPatch: { selector: '[data-testid="v2"]' } })
    expect(breaker.allows(different)).toBe(true)
  })

  it('a successful verify clears the watch (re-application allowed)', () => {
    const breaker = new PatchCircuitBreaker()
    const base = patch()
    breaker.applied(base)
    breaker.observeFailure(base)
    breaker.applied(base) // the patch verified OK this time → clear
    expect(breaker.allows(base)).toBe(true)
  })
})
