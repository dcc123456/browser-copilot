// @vitest-environment jsdom
/**
 * Code-node helper help: the editor advertises exactly the catalogue in
 * `src/lib/workflow/code-node-helpers.ts`, every advertised string has a
 * zh-CN rendering, and each chip opens a bubble with the purpose and use case.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CODE_NODE_HELPERS } from '../src/lib/workflow/code-node-helpers'
import { makeBlockTranslate, makeTranslate } from '../src/workflow-editor/i18n'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'
import HelperTip from '../src/workflow-editor/ui/HelperTip'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

const roots: Root[] = []

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount()
  })
  document.body.innerHTML = ''
})

function mountTip(locale: 'en' | 'zh' = 'en'): HTMLDivElement {
  const helper = CODE_NODE_HELPERS[0]!
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(
      createElement(
        EditorLocaleContext.Provider,
        { value: makeEditorLocale(locale, makeTranslate(locale)) },
        createElement(HelperTip, {
          signature: helper.signature,
          what: helper.what,
          when: helper.when,
        }),
      ),
    )
  })
  return container
}

function chip(container: ParentNode): HTMLButtonElement {
  const button = container.querySelector('button')
  if (!button) throw new Error('no helper chip')
  return button
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('code-node helper help', () => {
  it('advertises only implemented helpers', () => {
    const names = CODE_NODE_HELPERS.map((helper) => helper.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).not.toContain('automaFetch')
    expect(names).toEqual([
      'automaNextBlock',
      'automaSetVariable',
      'automaRefData',
      'automaResetTimeout',
      'variables',
    ])
  })

  it('has a zh-CN copy for every advertised string', () => {
    const bt = makeBlockTranslate('zh')
    const strings = [
      'What it does',
      'When to use it',
      ...CODE_NODE_HELPERS.flatMap((helper) => [helper.hint, helper.what, helper.when]),
    ]
    for (const source of strings) {
      expect(bt(source), source).not.toBe(source)
    }
  })

  it('opens a bubble with the signature, purpose and use case', () => {
    const container = mountTip()
    const button = chip(container)
    expect(button.getAttribute('aria-expanded')).toBe('false')

    click(button)

    expect(button.getAttribute('aria-expanded')).toBe('true')
    const bubble = container.querySelector('[role="dialog"]')
    expect(bubble?.textContent).toContain(CODE_NODE_HELPERS[0]!.signature)
    expect(bubble?.textContent).toContain('What it does')
    expect(bubble?.textContent).toContain(CODE_NODE_HELPERS[0]!.what)
    expect(bubble?.textContent).toContain('When to use it')
    expect(bubble?.textContent).toContain(CODE_NODE_HELPERS[0]!.when)
  })

  it('closes on a second click and on an outside pointer-down', () => {
    const container = mountTip()
    const button = chip(container)

    click(button)
    click(button)
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    click(button)
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    act(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('renders the zh-CN labels and copy in the zh locale', () => {
    const container = mountTip('zh')
    click(chip(container))
    const text = container.querySelector('[role="dialog"]')?.textContent ?? ''
    expect(text).toContain('作用')
    expect(text).toContain('使用场景')
    expect(text).toContain('结束脚本并把一个值传给下一个算子')
  })
})
