// @vitest-environment jsdom
/**
 * The `/` dynamic-variable menu inside a block parameter field.
 *
 * The graph rules themselves are pinned in `var-suggestions.spec.ts`; this file
 * is about the field half — when the menu opens, what a pick writes, and what
 * must never appear on screen:
 *
 * 1. a `/` at the caret (start or after whitespace) opens it, and ordinary text
 *    containing a slash (`https://`, `3/4`, `src/lib`) does not;
 * 2. arrows move the highlight, Enter picks, and the field receives the
 *    `{{reference}}` with the `/term` replaced;
 * 3. a mouse pick prevents default so the field keeps focus and its own
 *    blur-validation cannot overwrite the pick;
 * 4. an IME composition owns Enter — the menu neither opens nor picks mid-composition;
 * 5. `noSlash` (the name-defining fields) never opens it;
 * 6. a credential row shows `label · fieldKey` ONLY: the stored value appears
 *    nowhere in the DOM, and picking it goes through the host, which returns the
 *    `get-secret` variable name the field then references.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ listPasswords: vi.fn() }))

vi.mock('../src/lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/storage')>()
  return { ...actual, listPasswords: mocks.listPasswords }
})

import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TextArea, TextInput } from '../src/workflow-editor/blocks/shared/Field'
import { SlashMenuProvider } from '../src/workflow-editor/blocks/shared/SlashVariableMenu'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'
import type { SecretFieldRef, SuggestionGraph } from '../src/lib/workflow/var-suggestions'

/** trigger → get-text(`lastText`) → the node whose field is being edited. */
const GRAPH: SuggestionGraph = {
  nodes: [
    { id: 't', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger' } },
    {
      id: 'a',
      label: 'get-text',
      position: { x: 0, y: 0 },
      data: { blockId: 'get-text', variableName: 'lastText' },
    },
    { id: 'target', label: 'forms', position: { x: 0, y: 0 }, data: { blockId: 'forms' } },
  ],
  edges: [
    { id: 't->a', source: 't', target: 'a' },
    { id: 'a->target', source: 'a', target: 'target' },
  ],
  trigger: { type: 'manual', parameters: [{ name: 'keyword', type: 'string' }] },
}

/** One stored credential, with a value the DOM must never show. */
const CREDENTIAL = {
  id: 'pat',
  label: 'GitHub PAT',
  fields: [{ key: 'token', value: 'SUPER-SECRET', secret: true }],
  createdAt: 1,
  updatedAt: 1,
  useCount: 0,
}

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  mocks.listPasswords.mockResolvedValue([CREDENTIAL])
})

function locale(): ReturnType<typeof makeEditorLocale> {
  return makeEditorLocale('en', (key) => (EDITOR_STRINGS.en as Record<string, string>)[key] ?? key)
}

/** Portals live on `document.body`, so every test must unmount its own root. */
const mounted: Root[] = []

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount()
  })
  document.body.innerHTML = ''
})

interface MountOptions {
  noSlash?: boolean
  multiline?: boolean
  graph?: SuggestionGraph
  insertSecret?: (nodeId: string, ref: SecretFieldRef) => Promise<string>
}

interface Mounted {
  el: HTMLInputElement | HTMLTextAreaElement
  picks: SecretFieldRef[]
  root: Root
  /** Everything the portal put on the page, plus the field. */
  menu: () => Element | null
  rows: () => Element[]
}

async function mount(options: MountOptions = {}): Promise<Mounted> {
  const picks: SecretFieldRef[] = []
  const insertSecret =
    options.insertSecret ??
    (async (_nodeId: string, ref: SecretFieldRef) => {
      picks.push(ref)
      return `secret_${ref.credentialId}_${ref.fieldKey}`
    })

  function FieldUnderTest() {
    const [value, setValue] = useState('')
    const props = { value, onChange: setValue, noSlash: options.noSlash }
    return options.multiline
      ? createElement(TextArea, { ...props, rows: 2 })
      : createElement(TextInput, props)
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push(root)
  await act(async () => {
    root.render(
      createElement(
        EditorLocaleContext.Provider,
        { value: locale() },
        createElement(SlashMenuProvider, {
          nodeId: 'target',
          graph: () => options.graph ?? GRAPH,
          insertSecret,
          children: createElement(FieldUnderTest),
        }),
      ),
    )
  })
  const el = container.querySelector('input, textarea') as HTMLInputElement | HTMLTextAreaElement
  return {
    el,
    picks,
    root,
    menu: () => document.body.querySelector('[role="listbox"]'),
    rows: () => Array.from(document.body.querySelectorAll('[role="option"]')),
  }
}

/** Type into the field the way the browser does: value first, then `input`. */
function type(el: HTMLInputElement | HTMLTextAreaElement, next: string): void {
  act(() => {
    // React installs its own tracking `value` setter on the node, so a plain
    // assignment is seen as "no change" and the onChange never fires. Write
    // through the prototype setter, exactly as a real keystroke does.
    const prototype =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setValue = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    setValue?.call(el, next)
    el.setSelectionRange(next.length, next.length)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(el: Element, init: KeyboardEventInit): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
}

/** A real mouse pick: mousedown, with preventDefault observable afterwards. */
function mouseDownOn(row: Element): boolean {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  act(() => {
    row.dispatchEvent(event)
  })
  return event.defaultPrevented
}

describe('the / variable menu opens on a command slash only', () => {
  it('opens for a leading slash and for one after a space', async () => {
    const { el, menu } = await mount()
    type(el, '/')
    expect(menu()).not.toBeNull()
    expect(menu()?.textContent).toContain('keyword')
    expect(menu()?.textContent).toContain('lastText')

    type(el, 'search ')
    expect(menu()).toBeNull()
    type(el, 'search /')
    expect(menu()).not.toBeNull()
  })

  it('stays closed for slashes that are ordinary text', async () => {
    const { el, menu } = await mount()
    for (const text of ['https://', 'src/lib', '3/4', 'a/b/c']) {
      type(el, text)
      expect(menu(), text).toBeNull()
    }
  })

  it('never opens on a field that defines a name', async () => {
    const field = await mount({ noSlash: true })
    type(field.el, '/')
    expect(field.menu()).toBeNull()

    const area = await mount({ noSlash: true, multiline: true })
    type(area.el, '/')
    expect(area.menu()).toBeNull()
  })
})

describe('picking a suggestion', () => {
  it('writes the reference over the /term and closes', async () => {
    const { el, menu, rows } = await mount()
    type(el, '/last')
    expect(rows()).toHaveLength(1)
    press(el, { key: 'Enter' })
    expect(el.value).toBe('{{lastText}}')
    expect(menu()).toBeNull()
  })

  it('moves the highlight with the arrows and keeps Enter for the menu', async () => {
    const { el, rows } = await mount()
    type(el, '/')
    // The groups come back in list order: inputs, then upstream variables.
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true')
    press(el, { key: 'ArrowDown' })
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true')
    press(el, { key: 'Enter' })
    expect(el.value).toBe('{{lastText}}')
  })

  it('closes on Escape without touching the field', async () => {
    const { el, menu } = await mount()
    type(el, '/key')
    press(el, { key: 'Escape' })
    expect(menu()).toBeNull()
    expect(el.value).toBe('/key')
  })

  it('keeps the field focused on a mouse pick', async () => {
    const { el, rows } = await mount()
    type(el, '/key')
    expect(mouseDownOn(rows()[0]!)).toBe(true)
    expect(el.value).toBe('{{keyword}}')
  })

  it('gives an IME composition its Enter back', async () => {
    const { el, menu } = await mount()
    type(el, '/key')
    expect(menu()).not.toBeNull()
    // While a candidate list is open, Enter accepts the candidate — the menu
    // must not claim the keystroke.
    press(el, { key: 'Enter', isComposing: true })
    expect(el.value).toBe('/key')
    press(el, { key: 'Enter' })
    expect(el.value).toBe('{{keyword}}')
  })
})

describe('the credential rows', () => {
  it('show the label and field key, never the value', async () => {
    const { el, menu } = await mount()
    type(el, '/')
    expect(menu()?.textContent).toContain('GitHub PAT · token')
    expect(document.body.textContent ?? '').not.toContain('SUPER-SECRET')
  })

  it('ask the host for the producer and insert its variable name', async () => {
    const { el, picks, rows } = await mount()
    type(el, '/github')
    const secret = rows().find((row) => row.textContent?.includes('GitHub PAT'))
    expect(secret).toBeDefined()
    // The pick awaits the host, so flush it the way the browser would.
    await act(async () => {
      secret?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    })
    expect(picks).toEqual([{ credentialId: 'pat', fieldKey: 'token' }])
    expect(el.value).toBe('{{secret_pat_token}}')
    expect(document.body.textContent ?? '').not.toContain('SUPER-SECRET')
  })

  it('still works when the host has no credential storage', async () => {
    mocks.listPasswords.mockRejectedValueOnce(new Error('no chrome.storage here'))
    const { el, menu } = await mount()
    type(el, '/')
    expect(menu()?.textContent).toContain('lastText')
    expect(menu()?.textContent).not.toContain('GitHub PAT')
  })
})
