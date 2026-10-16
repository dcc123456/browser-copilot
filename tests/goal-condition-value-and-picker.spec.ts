/**
 * The two additions to the success-criteria vocabulary: a row can name the element
 * the operator PICKED on the page, and a row can read a form control's live value
 * (`elementValue` — 「只要有值」 and 「等于固定值」).
 *
 * The picker half is only worth anything if the write lands where the observer
 * reads: a rich `primary`/`fallbacks` target IGNORES the flat `selector` field, so
 * a naive write would show the operator a selector that changes nothing. The value
 * half is only worth anything if a prefilled control cannot certify a run, so the
 * pre-run snapshot is part of the contract.
 */
import { describe, expect, it } from 'vitest'
import type { ConditionTarget } from '../src/lib/workflow/element-fingerprint'
import {
  conditionTargetName,
  conditionTargetSelector,
  conditionTargetSpecs,
  withConditionTargetSelector,
} from '../src/lib/workflow/element-fingerprint'
import {
  captureGoalBaseline,
  controlValueAsText,
  didHoldBeforeTheRun,
  evaluateCondition,
  type ConditionPageProbe,
} from '../src/background/workflow-engine/condition-runtime'
import {
  describeCondition,
  isHardCondition,
  isWorkflowCondition,
} from '../src/lib/workflow/conditions'
import type { WorkflowCondition } from '../src/lib/workflow/conditions'

const probeWith = (state: { value?: string; text?: string }): ConditionPageProbe => ({
  exists: async () => true,
  visible: async () => true,
  enabled: async () => true,
  text: async () => state.text,
  value: async () => state.value,
  attribute: async () => undefined,
  count: async () => 1,
  url: async () => 'https://x.test/publish',
})

const titleTarget: ConditionTarget = { accessibleName: '标题' }

describe('the selector the operator picked', () => {
  it('writes a flat selector on a locator and reads it back', () => {
    const next = withConditionTargetSelector({ accessibleName: '标题' }, '#title')
    expect(next).toEqual({ accessibleName: '标题', selector: '#title' })
    expect(conditionTargetSelector(next)).toBe('#title')
    // The observer searches exactly what the form showed.
    expect(conditionTargetSpecs(next)).toEqual([{ how: 'css', value: '#title' }])
  })

  it('aims a generated rich target at the picked element, keeping its specs as fallbacks', () => {
    const generated: ConditionTarget = {
      label: '标题输入框',
      primary: { how: 'role', value: '标题', role: 'textbox' },
      fallbacks: [{ how: 'text', value: '请填写标题' }],
    }
    const next = withConditionTargetSelector(generated, '#title')
    expect(next).toMatchObject({
      primary: { how: 'css', value: '#title' },
      fallbacks: [
        { how: 'role', value: '标题', role: 'textbox' },
        { how: 'text', value: '请填写标题' },
      ],
    })
    // The whole point: a write into `selector` here would be read by nobody.
    expect(conditionTargetSpecs(next)[0]).toEqual({ how: 'css', value: '#title' })
    // Nothing was re-labelled: the row still displays the words it was recorded with.
    expect(conditionTargetName(next)).toBe('标题输入框')
  })

  it('drops the picked element on clearing, leaving no empty css spec behind', () => {
    const bare = withConditionTargetSelector({ accessibleName: '标题', selector: '#title' }, '')
    expect(bare).toEqual({ accessibleName: '标题' })
    expect(conditionTargetSelector(bare)).toBe('')
    const rich = withConditionTargetSelector(
      { primary: { how: 'css', value: '#title' }, fallbacks: [{ how: 'text', value: '标题' }] },
      '  ',
    )
    expect(rich).toMatchObject({ primary: { how: 'text', value: '标题' }, fallbacks: [] })
  })

  it('keeps the row a valid condition either way', () => {
    expect(
      isWorkflowCondition({
        kind: 'elementExists',
        target: withConditionTargetSelector(titleTarget, '.t'),
      }),
    ).toBe(true)
    expect(
      isWorkflowCondition({
        kind: 'elementVisible',
        target: withConditionTargetSelector({ text: '草稿箱' }, '.note-item'),
      }),
    ).toBe(true)
  })
})

describe('the elementValue criterion', () => {
  it('accepts the two modes and refuses an equals row with no value to compare', () => {
    expect(
      isWorkflowCondition({ kind: 'elementValue', target: { text: 'a' }, op: 'notEmpty' }),
    ).toBe(true)
    expect(
      isWorkflowCondition({
        kind: 'elementValue',
        target: { text: 'a' },
        op: 'equals',
        expected: 'x',
      }),
    ).toBe(true)
    expect(isWorkflowCondition({ kind: 'elementValue', target: { text: 'a' } })).toBe(false)
    expect(isWorkflowCondition({ kind: 'elementValue', target: { text: 'a' }, op: 'gt' })).toBe(
      false,
    )
    expect(
      isWorkflowCondition({
        kind: 'elementValue',
        target: { text: 'a' },
        op: 'equals',
        expected: 7,
      }),
    ).toBe(false)
  })

  it('passes on any value and fails on an empty control', async () => {
    const row: WorkflowCondition = {
      kind: 'elementValue',
      target: { selector: '#title' },
      op: 'notEmpty',
    }
    expect(
      (await evaluateCondition(row, { variables: {}, probe: probeWith({ value: '  草稿 ' }) }))
        .satisfied,
    ).toBe(true)
    const empty = await evaluateCondition(row, {
      variables: {},
      probe: probeWith({ value: '   ' }),
    })
    expect(empty.satisfied).toBe(false)
    expect(empty.detail).toBe('控件为空')
  })

  it('compares the live value, interpolated with the run variables', async () => {
    const row: WorkflowCondition = {
      kind: 'elementValue',
      target: { selector: '#title' },
      op: 'equals',
      expected: '{{title}}',
    }
    const ok = await evaluateCondition(row, {
      variables: { title: '周末去哪玩' },
      probe: probeWith({ value: '周末去哪玩' }),
    })
    expect(ok.satisfied).toBe(true)
    const wrong = await evaluateCondition(row, {
      variables: { title: '周末去哪玩' },
      probe: probeWith({ value: '周末' }),
    })
    expect(wrong.satisfied).toBe(false)
    expect(wrong.detail).toBe('控件值为 "周末"')
  })

  it('reports a control with no readable value as uncheckable, not as empty', async () => {
    const row: WorkflowCondition = {
      kind: 'elementValue',
      target: { selector: '#upload' },
      op: 'notEmpty',
    }
    const outcome = await evaluateCondition(row, { variables: {}, probe: probeWith({}) })
    expect(outcome.satisfied).toBe(false)
    expect(outcome.detail).toBe('不是可读值的控件')
  })

  it('reads a text control as text and refuses a boolean, so an unchecked box cannot pass', () => {
    expect(controlValueAsText('草稿')).toBe('草稿')
    expect(controlValueAsText(['a', 'b'])).toBe('a, b')
    expect(controlValueAsText(false)).toBeUndefined()
    expect(controlValueAsText(true)).toBeUndefined()
    expect(controlValueAsText(null)).toBeUndefined()
  })

  it('describes both modes and is a hard fact about the step', () => {
    const notEmpty: WorkflowCondition = {
      kind: 'elementValue',
      target: { text: '标题' },
      op: 'notEmpty',
    }
    const equals: WorkflowCondition = {
      kind: 'elementValue',
      target: { text: '标题' },
      op: 'equals',
      expected: '草稿',
    }
    expect(describeCondition(notEmpty)).toBe('控件有值（"标题"）')
    expect(describeCondition(equals)).toBe('控件值等于 "草稿"（"标题"）')
    expect(isHardCondition(notEmpty)).toBe(true)
  })

  it('cannot be certified by a value the page already held before the run', async () => {
    const row: WorkflowCondition = {
      kind: 'elementValue',
      target: { selector: '#title' },
      op: 'notEmpty',
    }
    const prefilled = await captureGoalBaseline([row], probeWith({ value: '上次的草稿' }))
    expect(await didHoldBeforeTheRun(row, prefilled)).toBe(true)
    const blank = await captureGoalBaseline([row], probeWith({ value: '' }))
    expect(await didHoldBeforeTheRun(row, blank)).toBe(false)
  })
})
