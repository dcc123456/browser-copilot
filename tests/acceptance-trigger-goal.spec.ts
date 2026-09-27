import { describe, expect, it } from 'vitest'
import { describeCondition, type WorkflowCondition } from '../src/lib/workflow/conditions'
describe('V09 trigger goal contract', () => {
  const goalSpec = {
    summary: 'The form is submitted and the success banner appears.',
    successConditions: [{ kind: 'elementExists', target: { testId: 'success-banner' } }] as WorkflowCondition[],
  }
  it('the trigger description includes the goal summary', () => {
    // operator-tool-handler.compose builds this description:
    const description = `${goalSpec.summary} | Success: ${goalSpec.successConditions.map(describeCondition).join('; ')}`
    expect(description).toContain(goalSpec.summary)
  })
  it('the trigger description includes the success criteria', () => {
    const criteriaText = goalSpec.successConditions.map(describeCondition).join('; ')
    expect(criteriaText.length).toBeGreaterThan(0)
    const description = `${goalSpec.summary} | Success: ${criteriaText}`
    expect(description).toContain('Success:')
    expect(description).toContain(criteriaText)
  })
  it('the machine-readable goal is kept alongside the description', () => {
    // compose sets triggerHead.data['goalSpec'] = preparedContract.goalSpec
    const triggerData = { blockId: 'trigger', description: goalSpec.summary, goalSpec }
    expect(triggerData['goalSpec']?.summary).toBe(goalSpec.summary)
  })
})