import { describe, expect, it } from 'vitest'
import {
  conditionTargetIsNamed,
  describeCondition,
  isWorkflowCondition,
  workflowConditionsOf,
} from '../src/lib/workflow/conditions'
import { conditionTargetSpecs } from '../src/lib/workflow/element-fingerprint'

/**
 * Round 24 never generated a workflow: the model's `prepare_workflow_goal` contract
 * was refused nine times over element rows that named a real selector, so no
 * `wf_op_*` call ever ran. These pin the two shorthands a model writes when it has
 * just read a selector off the page, and the invariant the acceptance keeps: a row
 * that identifies NOTHING is still refused.
 */
describe('a goal row that names one element is readable', () => {
  it('accepts a selector-bearing target object', () => {
    const [condition] = workflowConditionsOf([
      { kind: 'elementExists', target: { selector: 'input[maxlength="20"]' } },
    ])
    expect(condition?.kind).toBe('elementExists')
    expect((condition as { target?: { selector?: string } })?.target?.selector).toBe(
      'input[maxlength="20"]',
    )
  })

  it('lifts a bare string target into a selector', () => {
    const [condition] = workflowConditionsOf([{ kind: 'elementVisible', target: '#note-body' }])
    expect(condition?.kind).toBe('elementVisible')
    expect((condition as { target?: { selector?: string } })?.target?.selector).toBe('#note-body')
  })

  it('lifts a top-level selector into the target', () => {
    const [condition] = workflowConditionsOf([
      { kind: 'elementText', selector: '.draft-toast', expected: '草稿', match: 'contains' },
    ])
    expect(condition?.kind).toBe('elementText')
    expect((condition as { target?: { selector?: string } })?.target?.selector).toBe('.draft-toast')
    expect((condition as { expected?: string }).expected).toBe('草稿')
  })

  it('still refuses a target that identifies nothing', () => {
    expect(workflowConditionsOf([{ kind: 'elementExists', target: {} }])).toEqual([])
    expect(workflowConditionsOf([{ kind: 'elementExists', target: '   ' }])).toEqual([])
    expect(isWorkflowCondition({ kind: 'elementExists', target: { relation: {} } })).toBe(false)
  })

  it('leaves a row it must not touch alone', () => {
    expect(workflowConditionsOf([{ kind: 'variableExists', name: 'aiTitle' }])).toEqual([
      { kind: 'variableExists', name: 'aiTitle' },
    ])
    expect(workflowConditionsOf([{ kind: 'urlContains', value: '/publish' }])).toHaveLength(1)
  })
})

/**
 * Round 26 replayed 18/18 steps and still failed its goal on `元素存在  — 元素不存在`:
 * the shape gate had learned to read `target: {selector}` while the OBSERVER had
 * not, so a row naming the very selector the node clicked had no spec to look
 * through — permanently false, and no report line said which element. Readable
 * and observable are the same requirement here, seen from two sides.
 */
describe('a readable row is also an observable one', () => {
  it('gives a selector-only target a CSS spec to observe through', () => {
    expect(conditionTargetSpecs({ selector: ".publishBtn, [class*='submit']" })).toEqual([
      { how: 'css', value: ".publishBtn, [class*='submit']" },
    ])
  })

  it('keeps identity ahead of the positional selector', () => {
    const specs = conditionTargetSpecs({
      selector: '#draft-btn',
      role: 'button',
      accessibleName: '暂存离开',
    })
    expect(specs[0]).toMatchObject({ how: 'role', value: '暂存离开' })
    expect(specs[1]).toMatchObject({ how: 'css', value: '#draft-btn' })
  })

  it('will not observe through a blank selector', () => {
    // `{how:'css', value:''}` is the spec that matches the whole page.
    expect(conditionTargetSpecs({ selector: '   ' })).toEqual([])
  })

  it('names the element in the log line instead of rendering nothing', () => {
    const [condition] = workflowConditionsOf([
      { kind: 'elementExists', target: { selector: '.publish-area .save-draft' } },
    ])
    expect(describeCondition(condition!)).toBe('元素存在 css ".publish-area .save-draft"')
  })
})

/**
 * Round 50 replayed 33/33 steps and the goal still read `元素存在 button`: the model
 * had just read a button off the page and written its accessible name under the
 * accessibility tree's word for it (`name`), while the observer searches
 * `accessibleName`. An unknown key is dropped silently, so the row kept only
 * `role:"button"` — a proof that «any button exists», which is always true and
 * proves nothing. `name` is now the third shorthand this seam recognizes.
 */
describe('the word a model uses for an accessible name', () => {
  it('rewrites target.name as accessibleName', () => {
    const [condition] = workflowConditionsOf([
      { kind: 'elementVisible', target: { role: 'button', name: '暂存离开' } },
    ])
    expect(condition).toMatchObject({
      kind: 'elementVisible',
      target: { role: 'button', accessibleName: '暂存离开' },
    })
    expect((condition as { target?: Record<string, unknown> }).target?.['name']).toBeUndefined()
  })

  it('keeps an accessibleName the model wrote correctly', () => {
    const [condition] = workflowConditionsOf([
      { kind: 'elementExists', target: { name: '草稿箱', accessibleName: '草稿' } },
    ])
    expect((condition as { target?: Record<string, unknown> }).target?.accessibleName).toBe('草稿')
  })

  it('makes the row a named target instead of a bare role', () => {
    const [lifted] = workflowConditionsOf([
      { kind: 'elementExists', target: { role: 'button', name: '暂存离开' } },
    ])
    const [bare] = workflowConditionsOf([{ kind: 'elementExists', target: { role: 'button' } }])
    expect(conditionTargetIsNamed(lifted!)).toBe(true)
    expect(conditionTargetIsNamed(bare!)).toBe(false)
  })
})
