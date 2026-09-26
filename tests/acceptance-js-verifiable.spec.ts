import { describe, expect, it } from 'vitest'
import { resolveNodeGoalContract } from '../src/lib/workflow/node-goal-instantiation'
import { withNodeGoalContract } from '../src/lib/workflow/node-goal-contract'
describe('V48 JS node stays verifiable after use', () => {
  const gapArgs = {
    description: 'extract data from a closed web component',
    variableName: 'extracted',
    script: 'return 1',
  }
  it('still resolves a node goal and success criteria', () => {
    const contract = resolveNodeGoalContract('javascript-code', gapArgs)
    expect(contract).toBeDefined()
    expect(contract!.successCriteria).toContainEqual({ kind: 'variableExists', name: 'extracted' })
  })
  it('attaches the contract to the recorded node', () => {
    const contract = resolveNodeGoalContract('javascript-code', gapArgs)!
    const data = withNodeGoalContract({ blockId: 'javascript-code' }, contract)
    expect(JSON.stringify(data)).toContain('__workflowAi')
  })
})