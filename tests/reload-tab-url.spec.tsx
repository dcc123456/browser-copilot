// @vitest-environment jsdom
/**
 * The `reload-tab` form's optional URL field (design:
 * specs/2026-10-19-reload-tab-url-design.md).
 *
 * The node used to have no settings at all, so nothing here was machine-checked:
 * `EDITOR_STRINGS` has no closed type behind it, and the block only became
 * editable when it gained this field. What has to stay true is that the field
 * writes the address into `data.url` untouched — the executor decides empty =
 * plain reload — and that the note explaining the two modes exists on BOTH sides
 * of the dictionary, because a missing zh entry silently renders English.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import EditReloadTab from '../src/workflow-editor/blocks/batchB/EditReloadTab'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

const roots: Root[] = []
const NOTE =
  'Leave the URL empty to reload the page as it is; fill it in to load that URL in the current tab instead.'

interface Form {
  container: HTMLDivElement
  urlField: HTMLInputElement
  /** The last patch the form emitted. */
  written: () => Record<string, unknown> | undefined
  type: (next: string) => void
}

/** Mount the form over a saved node's `data`, as the editor's sidebar would. */
function mount(data: Record<string, unknown>, locale: 'en' | 'zh' = 'en'): Form {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const t = (key: string) => (EDITOR_STRINGS[locale] as Record<string, string>)[key] ?? key

  let written: Record<string, unknown> | undefined
  act(() => {
    root.render(
      createElement(
        EditorLocaleContext.Provider,
        { value: makeEditorLocale(locale, t) },
        createElement(EditReloadTab, {
          data: { blockId: 'reload-tab', ...data },
          onChange: (patch: Record<string, unknown>) => {
            written = patch
          },
          blockId: 'reload-tab',
        } as never),
      ),
    )
  })

  const urlField = container.querySelector<HTMLInputElement>('input[type="text"]')!
  return {
    container,
    urlField,
    written: () => written,
    type: (next) => {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          urlField,
          next,
        )
        urlField.dispatchEvent(new Event('input', { bubbles: true }))
      })
    },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('reload-tab URL field', () => {
  it('writes the typed address into data.url, scheme and all', () => {
    const form = mount({ url: '' })
    form.type('https://example.com/cart')
    expect(form.written()).toEqual({ url: 'https://example.com/cart' })
  })

  it('shows a stored address again when the node reopens', () => {
    const form = mount({ url: 'http://127.0.0.1:8942/b' })
    expect(form.urlField.value).toBe('http://127.0.0.1:8942/b')
  })

  it('clears to the empty string, the value the executor reads as plain reload', () => {
    const form = mount({ url: 'https://example.com/cart' })
    form.type('')
    // No placeholder, no leftover: `''` is what makes the block reload in place.
    expect(form.written()).toEqual({ url: '' })
    expect(mount({ url: '' }).urlField.value).toBe('')
  })

  it('keeps the old node working: a url-less node renders an empty field', () => {
    // Nodes saved before this block had a form carry no `url` key at all, and
    // they must still open with the plain-reload behaviour selected.
    expect(mount({}).urlField.value).toBe('')
  })

  it('renders the two-modes note in both languages', () => {
    // `bt()` shows an untranslated string verbatim, so a missing zh dictionary
    // entry fails here rather than shipping English copy to a Chinese panel.
    expect(mount({}, 'en').container.textContent).toContain(NOTE)
    expect(mount({}, 'zh').container.textContent).toContain(
      'URL 留空则原地刷新当前页面；填入地址则改为在当前标签页打开该网址。',
    )
  })

  it('labels the field as optional in both languages', () => {
    expect(mount({}, 'en').container.textContent).toContain('URL (optional)')
    expect(mount({}, 'zh').container.textContent).toContain('网址（可选）')
  })
})
