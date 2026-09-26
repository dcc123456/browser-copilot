import { describe, expect, it } from 'vitest'
import {
  advanceRecovery, reportOperatorFailure, startRecovery,
  type OperatorFailureReport,
} from '../src/lib/workflow/recovery'
function failed(blockId: string, message: string, phase?: OperatorFailureReport['phase']): OperatorFailureReport {
  return reportOperatorFailure({ operator: blockId, message, ...(phase ? { phase } : {}) })
}
describe('29.2 all top-3 fail: classify then repair then expand', () => {
  it('classifies the three failure kinds and never jumps to JS', () => {
    const session = startRecovery({
      stepIntent: 'perform the step',
      failed: [
        failed('event-click', 'target not found'),
        failed('forms', 'this action is unsupported'),
        failed('upload-file', 'parameter error'),
      ],
    })
    const phases = [...session.failures.values()].map((f) => f.phase)
    expect(phases).toContain('target-resolution')
    expect(phases).toContain('unsupported')
    expect(phases).toContain('parameter')
    const step1 = advanceRecovery(session)
    // First move is analysis-driven, never JS.
    expect(step1.action.kind).not.toBe('capability-gap-js')
    let guard = 0
    let sawJs = false
    let step = step1
    while (guard < 8) {
      if (step.action.kind === 'capability-gap-js') { sawJs = true; break }
      step = advanceRecovery(session)
      guard++
    }
    // JS only appears after the full expand budget, not at the top.
    expect(guard).toBeGreaterThan(1)
    expect(sawJs).toBe(true)
  })
})
describe('29.3 recovery candidates', () => {
  it('returns the next candidates when top-3 are semantic mismatches', () => {
    const session = startRecovery({
      stepIntent: 'extract and save the result',
      failed: [
        failed('get-text', 'unsupported semantic mismatch', 'unsupported'),
        failed('attribute-value', 'unsupported semantic mismatch', 'unsupported'),
        failed('forms', 'unsupported semantic mismatch', 'unsupported'),
      ],
    })
    let step = advanceRecovery(session)
    let expanded: string[] | undefined
    for (let i = 0; i < 6; i++) {
      if (step.nextCandidates) { expanded = step.nextCandidates.candidateBlockIds; break }
      step = advanceRecovery(session)
    }
    expect(expanded).toBeDefined()
    expect(expanded!.length).toBeGreaterThan(0)
  })
  it('re-grounds first when all top-3 are target failures', () => {
    const session = startRecovery({
      stepIntent: 'click the item',
      failed: [
        failed('event-click', 'target not found'),
        failed('forms', 'target not found'),
        failed('hover-element', 'target not found'),
      ],
    })
    const step = advanceRecovery(session)
    expect(step.action.kind).toBe('reground')
  })
})