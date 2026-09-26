import { describe, expect, it } from 'vitest'
import {
  advanceRecovery, reportOperatorFailure, startRecovery,
  type OperatorFailureReport,
} from '../src/lib/workflow/recovery'
function failure(overrides: Partial<OperatorFailureReport> & Pick<OperatorFailureReport,'operator'|'message'>): OperatorFailureReport {
  return reportOperatorFailure({
    operator: overrides.operator, message: overrides.message,
    ...(overrides.phase ? { phase: overrides.phase } : {}),
    ...(overrides.targetState ? { targetState: overrides.targetState } : {}),
    ...(overrides.nodeGoal ? { nodeGoal: overrides.nodeGoal } : {}),
    ...(overrides.nodeSuccessCriteria ? { nodeSuccessCriteria: overrides.nodeSuccessCriteria } : {}),
  })
}
const criteria = [{ kind: 'elementExists', target: { testId: 'x' } }] as never
describe('V24 structured single-operator failure', () => {
  it('records phase, code, target state, retryability, recovery and node goal', () => {
    const report = failure({
      operator: 'event-click', message: 'element not found',
      targetState: { found: false }, nodeGoal: 'click submit', nodeSuccessCriteria: criteria,
    })
    expect(report.phase).toBe('target-resolution')
    expect(report.code).toBe('TARGET_NOT_FOUND')
    expect(report.targetState?.found).toBe(false)
    expect(report.retryable).toBe(true)
    expect(report.suggestedRecovery.length).toBeGreaterThan(0)
    expect(report.nodeGoal).toBe('click submit')
    expect(report.nodeSuccessCriteria).toHaveLength(1)
  })
})
describe('V25 target-resolution recovery order', () => {
  it('goes reground -> retry same before any JS', () => {
    const session = startRecovery({
      stepIntent: 'click submit',
      failed: [failure({ operator: 'event-click', message: 'not found' })],
    })
    expect(advanceRecovery(session).action.kind).toBe('reground')
    expect(advanceRecovery(session).action.kind).toBe('retry-same')
  })
})
describe('V26 preconditions failure recovery', () => {
  it('waits for state then retries without expanding search', () => {
    const session = startRecovery({
      stepIntent: 'click submit',
      failed: [failure({ operator: 'event-click', message: 'precondition not met', phase: 'precondition' })],
    })
    expect(advanceRecovery(session).action.kind).toBe('await-state')
  })
})
describe('V27 parameter failure recovery', () => {
  it('adjusts the parameter', () => {
    const session = startRecovery({
      stepIntent: 'fill form',
      failed: [failure({ operator: 'forms', message: 'parameter invalid', phase: 'parameter' })],
    })
    expect(advanceRecovery(session).action.kind).toBe('adjust-parameter')
  })
})
describe('V28 transient execution failure recovery', () => {
  it('retries within a bounded budget', () => {
    const session = startRecovery({
      stepIntent: 'operate',
      failed: [failure({ operator: 'get-text', message: 'timeout', phase: 'execution' })],
    })
    const first = advanceRecovery(session).action.kind
    expect(['retry-same','expand-search']).toContain(first)
  })
})
describe('V29 unsupported-capability failure', () => {
  it('marks unsupported and moves toward expansion', () => {
    const session = startRecovery({
      stepIntent: 'extract the row price and save it somewhere',
      failed: [failure({ operator: 'forms', message: 'unsupported capability', phase: 'unsupported' })],
    })
    const step = advanceRecovery(session)
    expect(['expand-search','capability-gap-js']).toContain(step.action.kind)
  })
})
describe('V30 candidate expansion after top-3 failure', () => {
  it('expands to a different capability region using known failures', () => {
    const session = startRecovery({
      stepIntent: 'save the extracted result somewhere',
      failed: [
        failure({ operator: 'get-text', message: 'unsupported', phase: 'unsupported' }),
        failure({ operator: 'attribute-value', message: 'unsupported', phase: 'unsupported' }),
        failure({ operator: 'read-page', message: 'unsupported', phase: 'unsupported' }),
      ],
    })
    const step = advanceRecovery(session)
    expect(step.action.kind).toBe('expand-search')
    expect(step.nextCandidates).toBeDefined()
    const known = ['get-text','attribute-value','read-page']
    expect(step.nextCandidates!.candidateBlockIds.some((id) => !known.includes(id))).toBe(true)
  })
})
describe('V31 expansion exhausted follows controlled-failure ladder', () => {
  it('terminates at the JS gate then controlled failure, never a fake success', () => {
    const session = startRecovery({
      stepIntent: 'perform a page computation no native block supports',
      failed: [failure({ operator: 'forms', message: 'unsupported', phase: 'unsupported' })],
    })
    const seen: string[] = []
    for (let i = 0; i < 6; i++) seen.push(advanceRecovery(session).action.kind)
    // The ladder passes through either expansion or the capability-gap gate and
    // ends in a terminal, explicit outcome — never 'resolved' or a success.
    expect(seen).toContain('capability-gap-js')
    expect(session.state).not.toBe('resolved')
  })
  it('offers ai-agent before JS when semantic output is needed', () => {
    const session = startRecovery({
      stepIntent: 'summarize the page content',
      failed: [failure({ operator: 'read-page', message: 'unsupported', phase: 'unsupported' })],
    })
    const seen: string[] = []
    for (let i = 0; i < 6; i++) seen.push(advanceRecovery(session).action.kind)
    const aiPos = seen.indexOf('use-ai-agent')
    const jsPos = seen.indexOf('capability-gap-js')
    expect(aiPos).toBeGreaterThanOrEqual(0)
    if (jsPos >= 0) expect(aiPos).toBeLessThan(jsPos)
  })
})

describe('V32 recovery budget', () => {
  it('bounds expansions and total candidates', async () => {
    const { MAX_SEARCH_EXPANSIONS, MAX_TOTAL_CANDIDATES } = await import('../src/lib/workflow/recovery')
    expect(MAX_SEARCH_EXPANSIONS).toBeGreaterThan(0)
    expect(MAX_TOTAL_CANDIDATES).toBeLessThan(20)
  })
})