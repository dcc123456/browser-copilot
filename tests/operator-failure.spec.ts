import { describe, expect, it } from 'vitest'
import {
  buildOperatorFailureEvidence,
  type OperatorFailureCode,
} from '../src/lib/workflow/operator-failure'

describe('buildOperatorFailureEvidence', () => {
  it('classifies a runtime error message into the shared failure vocabulary', () => {
    const evidence = buildOperatorFailureEvidence({
      errorMessage: 'READINESS_TIMEOUT(visible): 元素尚未可见',
    })
    expect(evidence.failureCode).toBe('READINESS_TIMEOUT')
    expect(evidence.category).toBe('readiness')
    expect(evidence.failureHint).toBeTruthy()
    expect(evidence.recoverable).toBe(true)
  })

  it('falls back to UNKNOWN for a message the runtime vocabulary does not cover', () => {
    const evidence = buildOperatorFailureEvidence({ errorMessage: 'something nobody has seen' })
    expect(evidence.failureCode).toBe('UNKNOWN')
    expect(evidence.category).toBe('workflow')
  })

  it('lets the caller override the code for a pre-execution refusal', () => {
    const evidence = buildOperatorFailureEvidence({
      errorMessage: 'Refused: the script needs a justification',
      code: 'PERMISSION_DENIED',
    })
    expect(evidence.failureCode).toBe('PERMISSION_DENIED')
    expect(evidence.recoverable).toBe(false)
    expect(evidence.aiRepairable).toBe(false)
    expect(evidence.failureHint).toBeTruthy()
  })

  it('takes the classification of a named code from the shared failure table', () => {
    const evidence = buildOperatorFailureEvidence({
      errorMessage: 'anything',
      code: 'LOCATOR_NOT_FOUND',
    })
    expect(evidence.category).toBe('locator')
    expect(evidence.aiRepairable).toBe(true)
  })

  it('truncates the error message to 200 characters', () => {
    const evidence = buildOperatorFailureEvidence({ errorMessage: 'x'.repeat(500) })
    expect(evidence.errorMessage).toHaveLength(200)
  })

  it('keeps at most eight candidate counts and keeps selector and count aligned', () => {
    const selectors = Array.from({ length: 12 }, (_, i) => `.c${i}`)
    const counts = selectors.map((_, i) => i * 2)
    const evidence = buildOperatorFailureEvidence({
      errorMessage: 'ambiguous',
      candidateSelectors: selectors,
      candidateCounts: counts,
    })
    expect(evidence.candidateCounts).toHaveLength(8)
    expect(evidence.candidateCounts?.[0]).toEqual({ selector: '.c0', count: 0 })
    expect(evidence.candidateCounts?.[7]).toEqual({ selector: '.c7', count: 14 })
  })

  it('omits candidate counts when the page was never probed', () => {
    const evidence = buildOperatorFailureEvidence({ errorMessage: 'ambiguous' })
    expect(evidence.candidateCounts).toBeUndefined()
  })

  it('reports a missing count as zero rather than dropping the candidate', () => {
    const evidence = buildOperatorFailureEvidence({
      errorMessage: 'ambiguous',
      candidateSelectors: ['.a', '.b'],
      candidateCounts: [3],
    })
    expect(evidence.candidateCounts).toEqual([
      { selector: '.a', count: 3 },
      { selector: '.b', count: 0 },
    ])
  })

  it('carries the locator resolution with exactly the three kernel fields', () => {
    const evidence = buildOperatorFailureEvidence({
      errorMessage: 'ambiguous',
      resolution: { usedSpec: 'text|保存', usedFallback: true, matched: 2 },
    })
    expect(Object.keys(evidence.locatorResolution ?? {}).sort()).toEqual([
      'matched',
      'usedFallback',
      'usedSpec',
    ])
    expect(evidence.locatorResolution?.usedFallback).toBe(true)
  })

  it('carries the page state and the safe rerun boundary', () => {
    const evidence = buildOperatorFailureEvidence({
      errorMessage: 'timed out',
      pageState: { url: 'https://example.com/editor', title: 'Editor' },
      safeRerunBoundary: { nodeId: 'n1', label: 'forms' },
    })
    expect(evidence.pageState?.url).toBe('https://example.com/editor')
    expect(evidence.safeRerunBoundary?.nodeId).toBe('n1')
  })

  it('never throws on an empty message', () => {
    const evidence = buildOperatorFailureEvidence({ errorMessage: '' })
    expect(evidence.failureCode).toBe('UNKNOWN')
    expect(evidence.errorMessage).toBe('')
  })

  it('accepts every code the runtime vocabulary defines', () => {
    const codes: OperatorFailureCode[] = ['LOCATOR_NOT_FOUND', 'READINESS_TIMEOUT', 'UNKNOWN']
    for (const code of codes) {
      const evidence = buildOperatorFailureEvidence({ errorMessage: 'x', code })
      expect(evidence.failureCode).toBe(code)
    }
  })
})
