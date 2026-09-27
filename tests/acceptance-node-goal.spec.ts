import { describe, expect, it } from 'vitest'
import { resolveNodeGoalContract } from '../src/lib/workflow/node-goal-instantiation'
import {
  normalizeNodeGoalContract, nodeGoalContractOf, withNodeGoalContract,
} from '../src/lib/workflow/node-goal-contract'
describe('V10 every generated action node type has a goal', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['event-click', { target: { testId: 'submit' } }],
    ['forms', { target: { testId: 'email' } }],
    ['new-tab', { url: 'https://x.test', variableName: 'opened' }],
    ['get-text', { variableName: 'title' }],
    ['attribute-value', { variableName: 'href' }],
    ['conditions', { target: { testId: 'err' } }],
    ['while-loop', { target: { testId: 'x' } }],
    ['data-mapping', { variableName: 'mapped' }],
    ['ai-agent', { variableName: 'reply' }],
  ]
  it.each(cases)('%s resolves an instantiated contract', (blockId, args) => {
    const contract = resolveNodeGoalContract(blockId, args)
    expect(contract).toBeDefined()
    expect(contract!.goal.length).toBeGreaterThan(0)
    expect(contract!.successCriteria.length).toBeGreaterThan(0)
  })
})
describe('V11 contract field completeness', () => {
  it('round-trips full optional fields without empty placeholders', () => {
    const contract = normalizeNodeGoalContract({
      version: 1,
      goal: 'Open the form',
      successCriteria: [{ kind: 'elementExists', target: { testId: 'form' } }],
      preconditions: [{ kind: 'elementVisible', target: { testId: 'btn' } }],
      failureMeaning: ['The form did not open.'],
      repairHints: [{ target: 'locator', action: 'Re-ground on the navigation button.' }],
    })!
    expect(contract.goal).toBe('Open the form')
    expect(contract.preconditions).toHaveLength(1)
    expect(contract.failureMeaning).toContain('The form did not open.')
    expect(contract.repairHints?.[0]?.action).toContain('Re-ground')
  })
  it('drops empty-string field values', () => {
    const contract = normalizeNodeGoalContract({
      version: 1, goal: 'g', successCriteria: [{ kind: 'variableExists', name: 'x' }], evidence: [''],
    })!
    expect(contract.evidence).toBeUndefined()
  })
})
describe('V12 node goal matches local execution semantics', () => {
  it('instantiates an operator-local goal, not the workflow goal', () => {
    const contract = resolveNodeGoalContract('event-click', {
      target: { testId: 'create' }, description: 'click create',
    })!
    expect(contract.goal.toLowerCase()).not.toContain('customer created')
  })
})
describe('V14 editing the contract invalidates prior verification', () => {
  it('a changed goal produces a distinct contract', () => {
    const original = withNodeGoalContract({ blockId: 'forms' }, {
      version: 1, goal: 'old goal', successCriteria: [{ kind: 'variableExists', name: 'x' }],
    })
    const edited = withNodeGoalContract(original, {
      version: 1, goal: 'new goal', successCriteria: [{ kind: 'variableExists', name: 'y' }],
    })
    expect(nodeGoalContractOf(edited)?.goal).toBe('new goal')
    // The editor observes this change and resets certification to unverified (see App.tsx).
  })
})