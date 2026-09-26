import { describe, expect, it } from 'vitest'
import { resolveNodeGoalContract } from '../src/lib/workflow/node-goal-instantiation'
import {
  nodeGoalContractOf, withNodeGoalContract,
} from '../src/lib/workflow/node-goal-contract'
import {
  generateWorkflowName, isAcceptableWorkflowName, normalizeGenerationGoalContract,
} from '../src/lib/workflow/generation-goal'
describe('29.7 node goal', () => {
  it('instantiates a specific node goal with checkable criteria', () => {
    const contract = resolveNodeGoalContract('forms', {
      selector: '#email', value: 'alice@example.com', variableName: 'emailValue',
    })
    expect(contract).toBeDefined()
    expect(contract!.goal.length).toBeGreaterThan(0)
    expect(contract!.successCriteria.length).toBeGreaterThan(0)
    const data = withNodeGoalContract({ blockId: 'forms' }, contract!)
    expect(nodeGoalContractOf(data)?.goal).toBe(contract!.goal)
  })
  it('prefers a supplied model-authored contract', () => {
    const supplied = { version: 1, goal: 'custom authored goal', successCriteria: [{ kind: 'variableExists', name: 'x' }] }
    const contract = resolveNodeGoalContract('forms', {}, supplied)
    expect(contract!.goal).toBe('custom authored goal')
  })
  it('returns a variable criterion for blocks that output a variable', () => {
    const contract = resolveNodeGoalContract('get-text', { variableName: 'title' })
    expect(contract!.successCriteria).toContainEqual({ kind: 'variableExists', name: 'title' })
  })
})
describe('29.8 workflow goal', () => {
  it('derives a meaningful bilingual workflow name', () => {
    const en = generateWorkflowName('scrape product prices from the search results')
    const zh = generateWorkflowName('抓取搜索结果中的商品价格')
    expect(en.length).toBeGreaterThan(0)
    expect(zh.length).toBeGreaterThan(0)
    expect(isAcceptableWorkflowName(en)).toBe(true)
  })
  it('rejects placeholder names', () => {
    expect(isAcceptableWorkflowName('new workflow')).toBe(false)
    expect(isAcceptableWorkflowName('workflow-abc123')).toBe(false)
    expect(isAcceptableWorkflowName('test')).toBe(false)
  })
  it('validates a generation goal contract with machine-checkable conditions', () => {
    const contract = normalizeGenerationGoalContract({
      version: 1,
      name: 'Collect product prices',
      goalSpec: {
        summary: 'The product price table is collected.',
        successConditions: [{ kind: 'variableExists', name: 'prices' }],
      },
      requiredCapabilities: ['read-text', 'loop'],
    })
    expect(contract).toBeDefined()
    expect(contract!.requiredCapabilities).toEqual(['read-text', 'loop'])
  })
  it('rejects a contract without success conditions', () => {
    const contract = normalizeGenerationGoalContract({
      version: 1, name: 'Broken', goalSpec: { summary: 'done', successConditions: [] }, requiredCapabilities: [],
    })
    expect(contract).toBeUndefined()
  })
})