/**
 * The editor half of the no-goal ruling (spec
 * `specs/2026-10-15-notification-feishu-and-goal-free-design.md` §3.1): a
 * fire-and-done operator gets neither the 「目标与成功条件」 section nor the AI-fix
 * entry — the fix engine refuses a node without a goal contract, so leaving the
 * button up would be a dead end. Plus the notification form's Feishu switch.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import BlockEditForm from '../src/workflow-editor/sidebar/BlockEditForm'
import { BLOCK_BY_ID } from '../src/lib/workflow/blocks/palette'
import { NON_GOAL_BEARING_BLOCK_IDS } from '../src/lib/workflow/operator-class'
import { BLOCK_FORM_STRINGS_ZH } from '../src/workflow-editor/i18n'

const t = (key: string) => key
const noop = () => {}

function render(blockId: string, data: Record<string, unknown> = {}): string {
  const block = BLOCK_BY_ID.get(blockId)!
  return renderToStaticMarkup(
    createElement(BlockEditForm, {
      block,
      nodeName: blockId,
      data,
      onChange: noop,
      onBack: noop,
      t,
      onApplyFix: noop,
      canRevert: false,
      onRevert: noop,
    }),
  )
}

describe('block edit form: goal section and AI fix', () => {
  it('hides both from the fire-and-done operators', () => {
    for (const blockId of NON_GOAL_BEARING_BLOCK_IDS) {
      const markup = render(blockId)
      expect(markup, blockId).not.toContain('nodeGoalSection')
      expect(markup, blockId).not.toContain('AI Fix')
    }
  })

  it('keeps both for a goal-bearing operator', () => {
    const markup = render('forms', { blockId: 'forms', selector: '.title' })
    expect(markup).toContain('nodeGoalSection')
    expect(markup).toContain('AI Fix')
  })

  it('renders the Feishu switch on the notification block', () => {
    expect(render('notification')).toContain('Send to Feishu')
    expect(render('notification', { notifyFeishu: true })).toContain('checked')
    expect(BLOCK_FORM_STRINGS_ZH['Send to Feishu']).toBe('发送到飞书')
  })
})
