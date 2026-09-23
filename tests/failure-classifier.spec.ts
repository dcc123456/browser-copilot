/**
 * Failure classification + evidence tests (spec §10, Phase 7): priority
 * classification, redaction BEFORE anything leaves the module, length caps,
 * and takeover-request enrichment.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyFailureMessage,
  FAILURE_TABLE,
} from '../src/lib/workflow/failure-code'
import {
  buildExecutionEvidence,
  redactText,
  redactVariables,
  EVIDENCE_READBACK_CAP,
} from '../src/lib/workflow/execution-evidence'
import { classifyFailure, withFailureVerdict } from '../src/background/workflow-engine/failure-classifier'
import type { ExecutionEvidence } from '../src/lib/workflow/execution-evidence'
import type { AiTakeoverRequest } from '../src/background/workflow-engine/engine'

describe('classifyFailureMessage — priority', () => {
  it('runtime codes classify with category and repairability', () => {
    expect(classifyFailureMessage('LOCATOR_AMBIGUOUS: 定位不确定').code).toBe('LOCATOR_AMBIGUOUS')
    expect(classifyFailureMessage('READINESS_TIMEOUT(visible): 页面未就绪').code).toBe('READINESS_TIMEOUT')
    expect(classifyFailureMessage('POSTCONDITION_FAILED: URL 包含 "/dashboard"').category).toBe('contract')
    expect(classifyFailureMessage('GOAL_NOT_ACHIEVED: 目标未达成').category).toBe('goal')
  })

  it('safety codes are never recoverable nor ai-repairable', () => {
    const verdict = classifyFailureMessage('SIDE_EFFECT_UNSAFE: 提交终态不确定')
    expect(verdict.recoverable).toBe(false)
    expect(verdict.aiRepairable).toBe(false)
  })

  it('locator codes are repairable', () => {
    const verdict = classifyFailureMessage('LOCATOR_NOT_FOUND: no element matched')
    expect(verdict.recoverable).toBe(true)
    expect(verdict.aiRepairable).toBe(true)
  })

  it('legacy executor text still classifies (元素未找到)', () => {
    expect(classifyFailureMessage('元素未找到: .stale').code).toBe('ELEMENT_NOT_FOUND')
  })

  it('unknown messages fail open into UNKNOWN but stay repairable', () => {
    const verdict = classifyFailureMessage('some totally new error')
    expect(verdict.code).toBe('UNKNOWN')
    expect(verdict.aiRepairable).toBe(true)
  })

  it('every table row carries a non-empty hint', () => {
    for (const row of FAILURE_TABLE) {
      expect(row.hint.length).toBeGreaterThan(4)
    }
  })
})

describe('execution evidence — redaction', () => {
  it('masks secret-named variables entirely', () => {
    const out = redactVariables({ password: 'hunter2', username: 'zhang' })
    expect(out['password']).toBe('***')
    expect(out['username']).not.toBe('***')
  })

  it('masks secret-looking values under innocent keys', () => {
    expect(redactText('Bearer abc.def.ghi')).not.toContain('abc.def.ghi')
    expect(redactText('token=abcdef123456; path=/')).not.toContain('abcdef123456')
    expect(redactText('4111111111111111')).not.toContain('4111111111111111')
  })

  it('caps long strings with a length note', () => {
    const long = 'x'.repeat(2000)
    const out = redactText(long, 300)
    expect(out.length).toBeLessThan(320)
    expect(out).toContain('2000 chars')
  })

  it('caps the readback at its own, larger budget', () => {
    const evidence = buildExecutionEvidence({ readback: 'y'.repeat(5000) })
    expect(evidence.readback!.length).toBeLessThan(EVIDENCE_READBACK_CAP + 20)
  })

  it('caps the step tail to the last lines', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `step ${i}`)
    const evidence = buildExecutionEvidence({ stepLines: lines })
    expect(evidence.stepTail).toHaveLength(10)
    expect(evidence.stepTail!.at(-1)).toBe('step 39')
  })
})

describe('classifyFailure — verdict shape', () => {
  it('carries evidence, message verbatim, and a repair hint by code', () => {
    const verdict = classifyFailure({
      error: 'LOCATOR_AMBIGUOUS: 定位不确定',
      url: 'https://shop.test/cart',
      selector: '.card',
      locator: { code: 'LOCATOR_AMBIGUOUS', matchCount: 3, candidates: [{ strategy: 'css', score: 35 }] },
      variables: { password: 'x', qty: '2' },
      stepLines: ['a', 'b'],
    })
    expect(verdict.message).toBe('LOCATOR_AMBIGUOUS: 定位不确定')
    expect(verdict.repairHint).toBe('locator')
    expect(verdict.evidence.locator?.matchCount).toBe(3)
    expect(verdict.evidence.variables?.['password']).toBe('***')
    expect(verdict.evidence.variables?.['qty']).toBe('2')
  })

  it('goal failures get no repair hint (the graph ran fine; the goal failed)', () => {
    const verdict = classifyFailure({ error: 'GOAL_NOT_ACHIEVED: 目标未达成' })
    expect(verdict.repairHint).toBeUndefined()
  })
})

describe('withFailureVerdict — takeover enrichment', () => {
  const base: AiTakeoverRequest = {
    workflow: { id: 'wf' } as AiTakeoverRequest['workflow'],
    failingNodeId: 'n2',
    failedBlockId: 'event-click',
    failedParams: { selector: '#x' },
    failedError: 'LOCATOR_NOT_FOUND: no element matched',
    steps: [],
    variables: {},
    signal: new AbortController().signal,
  }

  it('attaches the redacted verdict to the request', () => {
    const enriched = withFailureVerdict(base, {
      url: 'https://x.test/page',
      variables: { password: 'secret' },
    })
    const failure = (enriched as AiTakeoverRequest & {
      failure?: { code: string; evidence: ExecutionEvidence }
    })['failure']
    expect(failure?.code).toBe('LOCATOR_NOT_FOUND')
    expect(failure?.evidence.variables?.['password']).toBe('***')
    expect(failure?.evidence.url).toContain('x.test')
  })
})
