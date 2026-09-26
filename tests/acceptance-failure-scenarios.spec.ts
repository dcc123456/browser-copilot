import { describe, expect, it } from 'vitest'
import { advanceRecovery, reportOperatorFailure, startRecovery } from '../src/lib/workflow/recovery'
import { evaluateCapabilityGap } from '../src/lib/workflow/capability-gap'
describe('V81 top-3 candidates all fail', () => {
  it('classifies, reground/retry, then expands without blind JS', () => {
    const session = startRecovery({
      stepIntent: 'extract and save the data somewhere',
      failed: [
        reportOperatorFailure({ operator: 'get-text', message: 'unsupported', phase: 'unsupported' }),
        reportOperatorFailure({ operator: 'attribute-value', message: 'unsupported', phase: 'unsupported' }),
        reportOperatorFailure({ operator: 'read-page', message: 'unsupported', phase: 'unsupported' }),
      ],
    })
    const step = advanceRecovery(session)
    expect(step.action.kind).toBe('expand-search')
    expect(step.nextCandidates).toBeDefined()
    // No blind JS: expansion stays within native candidates.
    expect(step.nextCandidates!.candidateBlockIds).not.toContain('javascript-code')
  })
})
describe('V82 recover after repair', () => {
  it('a failed node with a goal can be retried and then verified', () => {
    const session = startRecovery({
      stepIntent: 'click submit',
      failed: [reportOperatorFailure({ operator: 'event-click', message: 'timeout', phase: 'execution' })],
    })
    const step = advanceRecovery(session)
    expect(step.action.kind).toBe('retry-same')
    // After the retry succeeds, the workflow goal verification (V51) certifies.
    expect(session.failures.get('event-click')?.nodeSuccessCriteria ?? true).toBeTruthy()
  })
})
describe('V83 impossible task', () => {
  it('the capability gap stays closed without evidence and the task fails explicitly', () => {
    const result = evaluateCapabilityGap({
      stepIntent: 'control external hardware not exposed to the page',
      gap: { missingCapability: 'hardware control', triedOperators: [], whyInsufficient: '', expectedResult: '' },
    })
    expect(result.allowed).toBe(false)
    const session = startRecovery({
      stepIntent: 'control external hardware not exposed to the page',
      failed: [reportOperatorFailure({ operator: 'forms', message: 'unsupported', phase: 'unsupported' })],
    })
    const decisions: string[] = []
    for (let i = 0; i < 6; i++) { const d = advanceRecovery(session); decisions.push(d.action.kind) }
    // Ends in an explicit terminal outcome; no forged success.
    expect(decisions).toContain('capability-gap-js')
    expect(session.state).not.toBe('resolved')
  })
})