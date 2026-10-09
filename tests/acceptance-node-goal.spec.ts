import { describe, expect, it } from 'vitest'
import { resolveNodeGoalContract } from '../src/lib/workflow/node-goal-instantiation'
import {
  normalizeNodeGoalContract,
  nodeGoalContractOf,
  withNodeGoalContract,
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
      version: 1,
      goal: 'g',
      successCriteria: [{ kind: 'variableExists', name: 'x' }],
      evidence: [''],
    })!
    expect(contract.evidence).toBeUndefined()
  })
})
describe('V12 node goal matches local execution semantics', () => {
  it('instantiates an operator-local goal, not the workflow goal', () => {
    const contract = resolveNodeGoalContract('event-click', {
      target: { testId: 'create' },
      description: 'click create',
    })!
    expect(contract.goal.toLowerCase()).not.toContain('customer created')
  })
})
describe('V14 editing the contract invalidates prior verification', () => {
  it('a changed goal produces a distinct contract', () => {
    const original = withNodeGoalContract(
      { blockId: 'forms' },
      {
        version: 1,
        goal: 'old goal',
        successCriteria: [{ kind: 'variableExists', name: 'x' }],
      },
    )
    const edited = withNodeGoalContract(original, {
      version: 1,
      goal: 'new goal',
      successCriteria: [{ kind: 'variableExists', name: 'y' }],
    })
    expect(nodeGoalContractOf(edited)?.goal).toBe('new goal')
    // The editor observes this change and resets certification to unverified (see App.tsx).
  })
})
describe('a fill does not promise the hint text it consumes', () => {
  // Round 58: the title `forms` step located its box by the placeholder
  // 「填写标题会有更多赞哦」 and the fallback contract said «that textbox exists».
  // Typing the title deletes the placeholder, so the step passed and its own
  // postcondition failed — and that one row was the only thing left standing
  // between a clean 20/20 replay and a certified goal.
  it('falls back to the recorded selector when the target is named by hint words', () => {
    const contract = resolveNodeGoalContract('forms', {
      target: { role: 'textbox', accessibleName: '填写标题会有更多赞哦' },
      selector: 'div.title-input > input',
      value: 'Browser Copilot：让 Chrome 拥有 AI 超能力',
    })
    expect(contract?.successCriteria).toEqual([
      {
        kind: 'elementExists',
        target: { stableAttributes: { 'data-css': 'div.title-input > input' } },
      },
    ])
  })

  it('declares no postcondition rather than a false one when only the hint remains', () => {
    const contract = resolveNodeGoalContract('forms', {
      target: { placeholder: '填写标题会有更多赞哦' },
      value: '{{articleData.title}}',
    })
    expect(contract).toBeUndefined()
  })

  it('does not promise the worded entry a click presses away', () => {
    // Round 67: the 「上传图文」 menu entry is what the click acts ON, and the
    // editor page it navigates to no longer shows it. The row held only before
    // the step, so a clean 14/14 replay that really saved the draft could never
    // certify. A word-named press target is a precondition; say nothing instead.
    const contract = resolveNodeGoalContract('event-click', {
      target: { text: '上传图文' },
    })
    expect(contract).toBeUndefined()
  })

  it('promises a click target the step leaves alone a handle for', () => {
    const contract = resolveNodeGoalContract('event-click', {
      target: { testId: 'submit' },
      selector: '#publish-entry',
    })
    expect(contract?.successCriteria).toEqual([
      { kind: 'elementExists', target: { testId: 'submit' } },
    ])
  })

  it('does not promise a selector keyed on the placeholder it overwrites', () => {
    // Round 68: the title fill recorded «元素存在 css "input[placeholder*=\"标题\"]"».
    // Typing the title is exactly what removes that placeholder, so the selector
    // rescue survived everything except the step's own action.
    const contract = resolveNodeGoalContract('forms', {
      target: { role: 'textbox', accessibleName: '填写标题会有更多赞哦' },
      selector: 'input[placeholder*="标题"]',
      value: '🚀 Browser Copilot：让浏览器操作变得简单的AI助手',
    })
    expect(contract).toBeUndefined()
  })

  it('keeps promising an element named by a machine handle, not by words', () => {
    const contract = resolveNodeGoalContract('forms', {
      target: { testId: 'title-field' },
      value: 'anything',
    })
    expect(contract?.successCriteria).toEqual([
      { kind: 'elementExists', target: { testId: 'title-field' } },
    ])
  })
})
