// @vitest-environment jsdom
/**
 * Block palette search: a fixed search box above the list, a flat result grid
 * while a query is active, and the pinned/category layout when it is cleared.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import BlockPalette from '../src/workflow-editor/sidebar/BlockPalette'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

const roots: Root[] = []

async function mount(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const t = (key: string) => (EDITOR_STRINGS.en as Record<string, string>)[key] ?? key
  await act(async () => {
    root.render(
      createElement(
        EditorLocaleContext.Provider,
        { value: makeEditorLocale('en', t) },
        createElement(BlockPalette),
      ),
    )
  })
  return container
}

function search(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')
  if (!input) throw new Error('no palette search box')
  return input
}

/** Type into the search box the way the browser does. */
function type(el: HTMLInputElement, next: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, next)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('block palette search', () => {
  it('starts on the pinned/category layout', async () => {
    const container = await mount()
    expect(container.querySelectorAll('.wf-palette-section').length).toBeGreaterThan(0)
  })

  it('links every card to the local operator reference', async () => {
    const container = await mount()
    const hrefs = [...container.querySelectorAll<HTMLAnchorElement>('a[title="Docs"]')].map(
      (link) => link.getAttribute('href'),
    )
    expect(hrefs).toHaveLength(63)
    expect(
      hrefs.every((href) =>
        href?.startsWith('https://dcc123456.github.io/browser-copilot/docs/operators-'),
      ),
    ).toBe(true)
    expect(hrefs).toContain(
      'https://dcc123456.github.io/browser-copilot/docs/operators-general.html#operator-webhook',
    )
  })

  it('filters across block names and drops the category sections', async () => {
    const container = await mount()
    type(search(container), 'webhook')
    expect(container.querySelectorAll('.wf-palette-section')).toHaveLength(0)
    // The webhook block's display name is "HTTP Request"; the query matches its
    // raw id, which is exactly the cross-field search this covers.
    const cards = container.querySelectorAll('.wf-palette-card')
    expect(cards).toHaveLength(1)
    expect(container.textContent).toContain('HTTP Request')
  })

  it('shows the empty state for gibberish', async () => {
    const container = await mount()
    type(search(container), 'zzzzqqq')
    expect(container.querySelectorAll('.wf-palette-card')).toHaveLength(0)
    expect(container.textContent).toContain('No matches')
  })

  it('restores the category layout when the query is cleared', async () => {
    const container = await mount()
    type(search(container), 'webhook')
    type(search(container), '')
    expect(container.querySelectorAll('.wf-palette-section').length).toBeGreaterThan(0)
  })
})
