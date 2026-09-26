import { describe, expect, it } from 'vitest'
import { findWorkflowOperators } from '../src/lib/workflow/operator-discovery'
describe('V19/V20 discovery inputs and executable candidates', () => {
  it('uses goal + intent and returns rich candidates', () => {
    const result = findWorkflowOperators({
      stepIntent: 'click the submit button',
      workflowGoal: 'The form is submitted successfully.',
      pageSignals: { hasForm: true },
      limit: 5,
    })
    expect(result.candidates.length).toBeGreaterThan(0)
    const top = result.candidates[0]!
    expect(top.blockId).toBeTruthy()
    expect(top.score).toBeGreaterThan(0)
    expect(top.reasons.length).toBeGreaterThan(0)
  })
})
describe('V21 discovery completes tool activation', () => {
  // Activation state lives in agent.ts; the DiscoveryResult is the contract that
  // tells the dispatcher what to activate. Tested end-to-end in goal-gate V06.
  it('returns candidate ids the dispatcher can activate directly', () => {
    const result = findWorkflowOperators({ stepIntent: 'read the heading text' })
    expect(result.candidateBlockIds.length).toBeGreaterThan(0)
  })
})
describe('V22 candidate count stays bounded', () => {
  it('defaults to at most 5', () => {
    const result = findWorkflowOperators({ stepIntent: 'click the thing' })
    expect(result.candidates.length).toBeLessThanOrEqual(5)
  })
})
describe('V23 native-first ordering', () => {
  it('ranks the native click operator above ai-agent and JS for a click task', () => {
    const result = findWorkflowOperators({ stepIntent: 'click the submit button', limit: 8 })
    const ids = result.candidateBlockIds
    const clickIdx = ids.indexOf('event-click')
    const aiIdx = ids.indexOf('ai-agent')
    const jsIdx = ids.indexOf('javascript-code')
    expect(clickIdx).toBe(0)
    if (aiIdx >= 0) expect(clickIdx).toBeLessThan(aiIdx)
    expect(jsIdx).toBe(-1)
  })
  it('ranks native forms above ai-agent for a deterministic fill', () => {
    const result = findWorkflowOperators({ stepIntent: 'fill the email field with a fixed value', limit: 8 })
    const ids = result.candidateBlockIds
    expect(ids[0]).toBe('forms')
    expect(ids).not.toContain('ai-agent')
  })
})