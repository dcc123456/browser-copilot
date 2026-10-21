// @vitest-environment jsdom
/**
 * The explainer next to 「目标与成功条件」 in every operator property panel.
 *
 * The section is collapsed by default and its contract is what per-step
 * verification and AI Optimize run on, so the panel needs a way to say so without
 * shipping the user to a doc. The toggle has to reveal the copy in place and
 * must not disturb the section it sits in — clicking the icon opening the
 * collapse (or the collapse hiding the note) would make the two controls fight.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import BlockEditForm from '../src/workflow-editor/sidebar/BlockEditForm'
import { BLOCK_BY_ID } from '../src/lib/workflow/blocks/palette'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'

const noop = () => {}
const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

// The `forms` form registers a picker-result listener on mount; jsdom has no
// extension host, so the channel is stubbed rather than exercised.
beforeEach(() => {
  vi.stubGlobal('chrome', {
    runtime: { onMessage: { addListener: noop, removeListener: noop } },
  })
})

function mount(blockId: string, locale: 'en' | 'zh' = 'en'): Root {
  const t = (key: string) => (EDITOR_STRINGS[locale] as Record<string, string>)[key] ?? key
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() =>
    root.render(
      createElement(
        EditorLocaleContext.Provider,
        { value: makeEditorLocale(locale, t) },
        createElement(BlockEditForm, {
          block: BLOCK_BY_ID.get(blockId)!,
          nodeName: blockId,
          data: { blockId, selector: '.title' },
          onChange: noop,
          onBack: noop,
          onApplyFix: noop,
          canRevert: false,
          onRevert: noop,
          t,
        }),
      ),
    ),
  )
  return root
}

const trigger = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="What is this section?"]')
const note = () => document.body.textContent?.includes(EDITOR_STRINGS.en.goalHelpIntro) ?? false
// The body marker is the note the inspector itself prints, since 'Goal' also
// occurs in the section header the toggle sits next to.
const goalField = () =>
  document.body.textContent?.includes(EDITOR_STRINGS.en.nodeInspectorEditInvalidates) ?? false

function click(el: HTMLElement) {
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('the goal section explainer', () => {
  it('offers the toggle on a goal-bearing operator and reveals the copy on click', () => {
    mount('forms')
    const button = trigger()
    expect(button).not.toBeNull()
    expect(note()).toBe(false)
    click(button!)
    expect(note()).toBe(true)
    // The contract's consequence is the part the user cannot guess.
    expect(document.body.textContent).toContain('AI Optimize then has to work from your own words')
    click(trigger()!)
    expect(note()).toBe(false)
  })

  it('leaves the collapsed section collapsed', () => {
    mount('forms')
    expect(goalField()).toBe(false)
    click(trigger()!)
    expect(note()).toBe(true)
    expect(goalField()).toBe(false)
  })

  it('is absent where there is no goal section to explain', () => {
    mount('notification')
    expect(trigger()).toBeNull()
    expect(note()).toBe(false)
  })

  it('shows the Chinese copy under zh', () => {
    mount('forms', 'zh')
    click(document.querySelector<HTMLButtonElement>('button[aria-label="这个区块是做什么的？"]')!)
    expect(document.body.textContent).toContain(EDITOR_STRINGS.zh.goalHelpCriteria)
  })
})
