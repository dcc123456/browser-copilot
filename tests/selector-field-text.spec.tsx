// @vitest-environment jsdom
/**
 * The block form's find-by control in Text mode: the pick/verify actions must
 * stay available, a pick must land the element's text in the field, and the
 * picker's dialect must be written back to the block — the click executor reads
 * `findBy` and `selector` as one locator, so a field holding text with
 * `findBy: 'cssSelector'` would try to parse "Buy" as a selector.
 *
 * @module tests/selector-field-text
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import SelectorField from '../src/workflow-editor/blocks/shared/SelectorField'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'
import type {
  ElementPickResult,
  SelectorVerifyResult,
} from '../src/workflow-editor/blocks/shared/element-pick'

const mocks = vi.hoisted(() => ({
  requestElementPick: vi.fn(),
  verifyElementSelector: vi.fn(),
}))

vi.mock('../src/workflow-editor/blocks/shared/element-pick', () => ({
  describePickFailure: (_failure: string, error?: string) => error ?? 'Could not pick.',
  requestElementPick: (...args: unknown[]) => mocks.requestElementPick(...args),
  verifyElementSelector: (...args: unknown[]) => mocks.verifyElementSelector(...args),
}))

const roots: Root[] = []

beforeEach(() => {
  mocks.requestElementPick.mockReset()
  mocks.verifyElementSelector.mockReset()
  mocks.requestElementPick.mockResolvedValue({
    ok: false,
    failure: 'cancelled',
  } satisfies ElementPickResult)
  mocks.verifyElementSelector.mockResolvedValue({
    ok: true,
    count: 1,
  } satisfies SelectorVerifyResult)
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
})

function Harness({
  initialSelector,
  initialFindBy,
  onSelector,
  onFindBy,
}: {
  initialSelector: string
  initialFindBy: string
  onSelector: (value: string) => void
  onFindBy: (value: string) => void
}) {
  const [selector, setSelector] = useState(initialSelector)
  const [findBy, setFindBy] = useState(initialFindBy)
  return createElement(SelectorField, {
    selector,
    onSelector: (value: string) => {
      setSelector(value)
      onSelector(value)
    },
    findBy,
    onFindBy: (value: string) => {
      setFindBy(value)
      onFindBy(value)
    },
  })
}

function mount(
  initialFindBy: string,
  initialSelector = '',
  handlers: { onSelector?: (value: string) => void; onFindBy?: (value: string) => void } = {},
) {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() =>
    root.render(
      createElement(
        EditorLocaleContext.Provider,
        { value: makeEditorLocale('en', (key: string) => key) },
        createElement(Harness, {
          initialSelector,
          initialFindBy,
          onSelector: handlers.onSelector ?? (() => {}),
          onFindBy: handlers.onFindBy ?? (() => {}),
        }),
      ),
    ),
  )
  return container
}

const pickButton = (scope: ParentNode) =>
  scope.querySelector<HTMLButtonElement>('button[title="Pick element on page"]')!
const verifyButton = (scope: ParentNode) =>
  scope.querySelector<HTMLButtonElement>('button[title="Verify selector"]')!
const textArea = (scope: ParentNode) => scope.querySelector<HTMLTextAreaElement>('textarea')!
const findby = (scope: ParentNode) => scope.querySelector<HTMLSelectElement>('select')!

describe('SelectorField in Text mode', () => {
  it('keeps the pick and verify actions and lands the picked text', async () => {
    mocks.requestElementPick.mockResolvedValue({
      ok: true,
      selector: 'Buy',
      findBy: 'text',
    } satisfies ElementPickResult)
    const onSelector = vi.fn()
    const onFindBy = vi.fn()
    const container = mount('text', '', { onSelector, onFindBy })

    expect(findby(container).value).toBe('text')
    expect(pickButton(container)).not.toBeNull()

    await act(async () => {
      pickButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.requestElementPick).toHaveBeenCalledWith({
      findBy: 'text',
      multiple: false,
      locale: 'en',
    })
    expect(textArea(container).value).toBe('Buy')
    expect(onSelector).toHaveBeenCalledWith('Buy')
    // Same dialect: nothing to rewrite.
    expect(onFindBy).not.toHaveBeenCalled()
  })

  it('writes the picker dialect back when the card switched to text', async () => {
    mocks.requestElementPick.mockResolvedValue({
      ok: true,
      selector: 'Buy',
      findBy: 'text',
    } satisfies ElementPickResult)
    const onFindBy = vi.fn()
    const container = mount('cssSelector', '', { onFindBy })

    await act(async () => {
      pickButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onFindBy).toHaveBeenCalledWith('text')
    expect(textArea(container).value).toBe('Buy')
  })

  it('verifies a text locator and reports the count inline', async () => {
    mocks.verifyElementSelector.mockResolvedValue({
      ok: true,
      count: 2,
    } satisfies SelectorVerifyResult)
    const container = mount('text', 'Buy')

    await act(async () => {
      verifyButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.verifyElementSelector).toHaveBeenCalledWith({
      selector: 'Buy',
      findBy: 'text',
      locale: 'en',
    })
    expect(container.textContent).toContain('Verified: 2 element(s) match')
  })
})
