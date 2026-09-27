import { describe, expect, it } from 'vitest'
import { findWorkflowOperators } from '../src/lib/workflow/operator-discovery'
describe('V69/V70 minimal, bounded operator loading', () => {
  it('a simple click task yields only the necessary operators', () => {
    const result = findWorkflowOperators({ stepIntent: 'click the submit button' })
    expect(result.candidates.length).toBeLessThanOrEqual(5)
    expect(result.candidateBlockIds).toContain('event-click')
    expect(result.candidateBlockIds).not.toContain('javascript-code')
  })
  it('a simple fill task stays within the candidate cap', () => {
    const result = findWorkflowOperators({ stepIntent: 'fill the email field' })
    expect(result.candidates.length).toBeLessThanOrEqual(5)
  })
  it('records average/maximum candidate counts across a sample', () => {
    const samples = ['click the button', 'fill the form', 'read the text', 'wait for the banner', 'open the settings']
    const counts = samples.map((text) => findWorkflowOperators({ stepIntent: text }).candidates.length)
    const average = counts.reduce((a, b) => a + b, 0) / counts.length
    const maximum = Math.max(...counts)
    expect(average).toBeLessThanOrEqual(5)
    expect(maximum).toBeLessThanOrEqual(5)
  })
})
describe('V73 no blind operator retries', () => {
  it('a repeated identical failure is classified before any retry (recovery requires a report)', async () => {
    const { reportOperatorFailure, startRecovery, advanceRecovery } = await import('../src/lib/workflow/recovery')
    const session = startRecovery({
      stepIntent: 'click submit',
      failed: [reportOperatorFailure({ operator: 'event-click', message: 'not found' })],
    })
    // Every retry decision follows a classified failure — never a blind re-call.
    const decision = advanceRecovery(session)
    expect(['reground','retry-same']).toContain(decision.action.kind)
    expect([...session.failures.values()][0]?.phase).toBeTruthy()
  })
})