import { describe, expect, it } from 'vitest'
import { advanceRecovery, reportOperatorFailure, startRecovery } from '../src/lib/workflow/recovery'
describe('V44 AI agent failure recovery', () => {
  it('does not jump to JS and offers a retry for an empty/malformed output', () => {
    const session = startRecovery({
      stepIntent: 'draft the personalized email',
      failed: [reportOperatorFailure({ operator: 'ai-agent', message: 'empty model output', phase: 'execution' })],
    })
    const first = advanceRecovery(session).action.kind
    expect(first).not.toBe('capability-gap-js')
    expect(first).toBe('retry-same')
  })
  it('can report a semantic-generation failure after analysis', () => {
    const session = startRecovery({
      stepIntent: 'draft the personalized email',
      failed: [reportOperatorFailure({ operator: 'ai-agent', message: 'unsupported', phase: 'unsupported' })],
    })
    // The decision must not silently succeed; it stays within the recovery ladder.
    const step = advanceRecovery(session)
    expect(['expand-search','use-ai-agent','capability-gap-js','report-blocked']).toContain(step.action.kind)
  })
})