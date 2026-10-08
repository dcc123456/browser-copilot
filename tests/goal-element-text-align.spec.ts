import { describe, expect, it } from 'vitest'
import { workflowConditionsOf, alignElementTextTarget } from '../src/lib/workflow/conditions'
import type { WorkflowCondition } from '../src/lib/workflow/conditions'

describe('an elementText row is aligned to its own expectation', () => {
  it('moves a locator worded with a different fragment onto the claimed words', () => {
    // Round 70 verbatim: locate 「保存」 and require its text to contain 「草稿」 —
    // the button says 「保存草稿」, so the row could never hold after the replay
    // that saved the draft. The expectation is the claim.
    const [row] = workflowConditionsOf([
      { kind: 'elementText', match: 'contains', target: { text: '保存' }, expected: '草稿' },
    ])
    expect((row as { target?: unknown }).target).toEqual({ text: '草稿' })
  })

  it('leaves a row whose words already agree with its expectation alone', () => {
    const row = alignElementTextTarget({
      kind: 'elementText',
      match: 'contains',
      target: { text: '草稿' },
      expected: '草稿',
    } as WorkflowCondition)
    expect((row as { target?: unknown }).target).toEqual({ text: '草稿' })
  })

  it('keeps a non-text locator that names a stable attribute', () => {
    const row = alignElementTextTarget({
      kind: 'elementText',
      match: 'contains',
      target: { stableAttributes: { 'data-testid': 'draft-count' } },
      expected: '草稿',
    } as WorkflowCondition)
    expect((row as { target?: unknown }).target).toEqual({
      stableAttributes: { 'data-testid': 'draft-count' },
    })
  })
})
