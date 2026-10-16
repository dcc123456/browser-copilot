// @vitest-environment jsdom
/**
 * The `new-tab` form's URL field: where the scheme lives.
 *
 * Picking a `{{variable}}` used to leave `https://` sitting in the path box, and
 * backspacing it away was undone by the very next keystroke — the protocol
 * dropdown re-attached the prefix to a variable that had none. The field now
 * keeps `url === protocol + path` true for every value, so the scheme lives in
 * the dropdown (where it can be taken off) and a bare domain still defaults to
 * https.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import EditNewTab from '../src/workflow-editor/blocks/batchB/EditNewTab'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

const roots: Root[] = []

interface Field {
  container: HTMLDivElement
  /** The last `url` the form wrote. */
  written: () => string | undefined
  protocol: HTMLSelectElement
  path: HTMLInputElement
  /** Render again with `url` as the stored value, as a re-open would. */
  settle: (url: string) => void
}

/** Mount the form over `url`, then hand back the two URL controls. */
async function mount(url: string): Promise<Field> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const t = (key: string) => (EDITOR_STRINGS.en as Record<string, string>)[key] ?? key

  const render = (stored: string): void => {
    act(() => {
      root.render(
        createElement(
          EditorLocaleContext.Provider,
          { value: makeEditorLocale('en', t) },
          createElement(EditNewTab, {
            data: { blockId: 'new-tab', url: stored },
            onChange: (patch: Record<string, unknown>) => {
              if (typeof patch.url === 'string') written = patch.url
            },
            blockId: 'new-tab',
          } as never),
        ),
      )
    })
  }

  let written: string | undefined
  render(url)

  const selects = [...container.querySelectorAll('select')]
  // The protocol dropdown is the one whose options are the schemes.
  const protocol = selects.find((s) => [...s.options].some((o) => o.value === 'https://'))!
  const path = [...container.querySelectorAll('input')].find((el) => el.type === 'text')!

  return {
    container,
    written: () => written,
    protocol,
    path,
    settle: (next: string) => {
      written = next
      render(next)
    },
  }
}

/** Type into the path box the way React sees it (the tracked setter). */
function type(field: Field, next: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      field.path,
      next,
    )
    field.path.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function choose(field: Field, value: string): void {
  act(() => {
    field.protocol.value = value
    field.protocol.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

afterEach(() => {
  // jsdom keeps the mounted form's listeners alive past the case otherwise.
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('new-tab URL field', () => {
  it('keeps the https prefix when a variable is picked', async () => {
    const field = await mount('')
    expect(field.protocol.value).toBe('https://')
    type(field, '{{base}}')
    expect(field.written()).toBe('https://{{base}}')
    // Re-opened, the prefix sits in the dropdown and the path box holds only
    // the variable — there is nothing left for a keystroke to re-attach.
    field.settle('https://{{base}}')
    expect(field.protocol.value).toBe('https://')
    expect(field.path.value).toBe('{{base}}')
  })

  it('lets the prefix be taken off a variable, and it stays off', async () => {
    const field = await mount('https://{{base}}')
    expect(field.path.value).toBe('{{base}}')
    choose(field, '')
    expect(field.written()).toBe('{{base}}')
    // Typing afterwards must not resurrect it.
    field.settle('{{base}}')
    expect(field.protocol.value).toBe('')
    type(field, '{{base}}/login')
    expect(field.written()).toBe('{{base}}/login')
  })

  it('reports no protocol for a bare variable and restores one on request', async () => {
    const field = await mount('{{base}}')
    expect(field.protocol.value).toBe('')
    expect(field.path.value).toBe('{{base}}')
    choose(field, 'http://')
    expect(field.written()).toBe('http://{{base}}')
  })

  it('still defaults a bare domain to https', async () => {
    const field = await mount('example.com')
    expect(field.protocol.value).toBe('https://')
    expect(field.path.value).toBe('example.com')
    type(field, 'example.com/login')
    expect(field.written()).toBe('https://example.com/login')
  })

  it('keeps a scheme typed into the path box while no protocol is selected', async () => {
    const field = await mount('{{base}}')
    expect(field.protocol.value).toBe('')
    type(field, 'https://example.com')
    expect(field.written()).toBe('https://example.com')
  })

  it('splits a stored scheme off the path box whatever it holds', async () => {
    for (const [url, protocol, path] of [
      ['ftp://host/x', 'ftp://', 'host/x'],
      ['file:///tmp/a', 'file://', '/tmp/a'],
      ['mailto:a@b.com', 'mailto:', 'a@b.com'],
      ['https://example.com', 'https://', 'example.com'],
    ] as const) {
      const field = await mount(url)
      expect([url, field.protocol.value, field.path.value]).toEqual([url, protocol, path])
    }
  })
})
