// @vitest-environment jsdom
/**
 * The `get-secret` form's output naming.
 *
 * Picking a credential used to leave `variableName` empty on purpose (a
 * machine-generated node must not invent one), which pushed the human into the
 * same trap: an explicit pick with nothing to name its output, so the run gate
 * then reports a missing required parameter. The form now pre-fills the field
 * key — while the operator keeps full control of the name, and a credential's
 * VALUE still never reaches the DOM.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ listPasswords: vi.fn() }))

vi.mock('../src/lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/storage')>()
  return { ...actual, listPasswords: mocks.listPasswords }
})

import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import EditGetSecret from '../src/workflow-editor/blocks/batchC/EditGetSecret'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'
import { credentialVariableNameOf } from '../src/lib/workflow/secret-params'
import { notifyStoreChanged } from '../src/lib/store-events'

const ENTRIES = [
  {
    id: 'pat',
    label: 'GitHub PAT',
    fields: [
      { key: 'token', value: 'SUPER-SECRET', secret: true },
      { key: 'user name', value: 'dcc', secret: false },
    ],
    createdAt: 1,
    updatedAt: 1,
    useCount: 0,
  },
]

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

const roots: Root[] = []
let patches: Record<string, unknown>[] = []

/** Mount the form over `data` and hand back its container. */
async function mountForm(data: Record<string, unknown>): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const t = (key: string) => (EDITOR_STRINGS.en as Record<string, string>)[key] ?? key
  // The dropdown only exists once `listPasswords()` has resolved.
  await act(async () => {
    root.render(
      createElement(
        EditorLocaleContext.Provider,
        { value: makeEditorLocale('en', t) },
        createElement(EditGetSecret, {
          data: { blockId: 'get-secret', ...data },
          onChange: (patch: Record<string, unknown>) => patches.push(patch),
          blockId: 'get-secret',
        } as never),
      ),
    )
  })
  return container
}

/** Mount the form over `data` and return its credential dropdown. */
async function mount(data: Record<string, unknown>): Promise<HTMLSelectElement> {
  const container = await mountForm(data)
  const select = container.querySelector('select')
  if (!select) throw new Error('no credential dropdown')
  return select
}

function pick(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const selectsOf = (container: HTMLElement): HTMLSelectElement[] => [
  ...container.querySelectorAll('select'),
]

const inputsOf = (container: HTMLElement): HTMLInputElement[] => [
  ...container.querySelectorAll('input'),
]

const rowsOf = (container: HTMLElement) => [...container.querySelectorAll('div.rounded-md')]

/** Fire a click the way React sees it. */
function click(button: Element | undefined): void {
  if (!button) throw new Error('no such button')
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** Type into a field the way the browser does (React's tracked setter swallows plain assignment). */
function type(el: HTMLInputElement, next: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, next)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The button whose accessible name is this English string (en locale → literal). */
function textButton(container: HTMLElement, label: string): Element {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label || b.getAttribute('title') === label,
  )
  if (!button) throw new Error(`no button labelled ${label}`)
  return button
}

beforeEach(() => {
  mocks.listPasswords.mockResolvedValue(ENTRIES)
  patches = []
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('get-secret output naming', () => {
  it('names the output after the picked field', async () => {
    pick(await mount({ credential: '', variableName: '' }), 'pat::token')
    expect(patches.at(-1)).toEqual({ credential: 'pat::token', variableName: 'token' })
  })

  it('keeps a name the operator typed', async () => {
    pick(await mount({ credential: '', variableName: 'apiKey' }), 'pat::token')
    // The row patch always carries both halves back; the name is UNCHANGED.
    expect(patches.at(-1)).toEqual({ credential: 'pat::token', variableName: 'apiKey' })
  })

  it('follows a name the form itself generated when the credential changes', async () => {
    pick(await mount({ credential: 'pat::token', variableName: 'token' }), 'pat::user name')
    expect(patches.at(-1)).toEqual({
      credential: 'pat::user name',
      variableName: credentialVariableNameOf({ credentialId: 'pat', fieldKey: 'user name' }),
    })
    expect(patches.at(-1)?.['variableName']).toBe('username')
  })

  it('sanitizes a field key into a reference-safe name', () => {
    expect(credentialVariableNameOf({ credentialId: 'pat', fieldKey: 'api.key' })).toBe('apikey')
    expect(credentialVariableNameOf({ credentialId: 'pat', fieldKey: '9lives' })).toBe(
      'input9lives',
    )
  })

  it('never puts a credential value on the page', async () => {
    await mount({ credential: 'pat::token', variableName: 'token' })
    expect(document.body.textContent).toContain('GitHub PAT · token')
    expect(document.body.innerHTML).not.toContain('SUPER-SECRET')
  })

  it('lists a credential imported while the form is open', async () => {
    const container = await mountForm({ credential: '', variableName: '' })
    expect(container.textContent).not.toContain('Marketplace import')

    mocks.listPasswords.mockResolvedValue([
      ...ENTRIES,
      {
        id: 'mkt-demo-secrets-gh',
        label: 'Marketplace import',
        fields: [{ key: 'token', value: 'ghp_published', secret: true }],
        createdAt: 2,
        updatedAt: 2,
        useCount: 0,
      },
    ])
    await act(async () => {
      notifyStoreChanged('passwords')
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Marketplace import · token')
  })
})

/**
 * The row list itself: one node fetching several credentials, so a workflow that
 * needs three keys is one node instead of three. Each row names its own output,
 * and the stored patch keeps mirroring row 1 into the flat pair.
 */
describe('get-secret credential rows', () => {
  const TWO_ROWS = {
    credential: 'pat::token',
    variableName: 'token',
    credentials: [
      { credential: 'pat::token', variableName: 'token' },
      { credential: 'pat::user name', variableName: 'username' },
    ],
  }

  it('shows one row per stored credential', async () => {
    const container = await mountForm(TWO_ROWS)
    expect(rowsOf(container)).toHaveLength(2)
    expect(selectsOf(container).map((s) => s.value)).toEqual(['pat::token', 'pat::user name'])
    expect(inputsOf(container).map((i) => i.value)).toEqual(['token', 'username'])
  })

  it('still offers "Add credential" when no credential is stored at all', async () => {
    // The reported symptom: nothing happened when clicking there. The button was
    // missing, because the whole row list was hidden behind an empty state.
    mocks.listPasswords.mockResolvedValue([])
    const container = await mountForm({})
    expect(textButton(container, 'Add credential')).toBeTruthy()

    click(textButton(container, 'Add credential'))
    expect(rowsOf(container)).toHaveLength(2)
    // And the blank rows still never reach the node: nothing names a credential.
    expect(patches.at(-1)).toMatchObject({ credential: '', variableName: '' })
    expect(patches.at(-1)).toMatchObject({ credentials: undefined })
  })

  it('adds an empty row without touching the ones already named', async () => {
    const container = await mountForm({ credential: 'pat::token', variableName: 'token' })
    click(textButton(container, 'Add credential'))
    // The new row is editor-local until it names a credential: a blank row must
    // never reach the node, or the run would ask for a credential nobody picked.
    // With one filled row the stored shape stays the flat pair.
    expect(patches.at(-1)).toMatchObject({
      credential: 'pat::token',
      variableName: 'token',
    })
    expect(rowsOf(container)).toHaveLength(2)
  })

  it('names only the row whose credential was picked', async () => {
    const container = await mountForm(TWO_ROWS)
    pick(selectsOf(container)[1]!, 'pat::token')
    expect(patches.at(-1)).toMatchObject({
      credentials: [
        { credential: 'pat::token', variableName: 'token' },
        { credential: 'pat::token', variableName: 'token' },
      ],
    })
  })

  it('lets the operator break a duplicate name the pick produced', async () => {
    // Picking the same credential twice writes the same name twice (which the
    // run gate reports), so the second row's name must stay editable. The editor
    // re-renders with each patch, hence the already-picked data here.
    const container = await mountForm({
      credential: 'pat::token',
      variableName: 'token',
      credentials: [
        { credential: 'pat::token', variableName: 'token' },
        { credential: 'pat::token', variableName: 'token' },
      ],
    })
    const name = inputsOf(container)[1]!
    type(name, 'githubToken')
    expect(patches.at(-1)).toMatchObject({
      credentials: [
        { credential: 'pat::token', variableName: 'token' },
        { credential: 'pat::token', variableName: 'githubToken' },
      ],
    })
  })

  it('removing a row collapses back to the flat pair', async () => {
    const container = await mountForm(TWO_ROWS)
    click(textButton(container, 'Remove credential'))
    expect(patches.at(-1)).toMatchObject({
      credential: 'pat::user name',
      variableName: 'username',
    })
    expect(patches.at(-1)?.['credentials']).toBeUndefined()
  })
})

/**
 * The form in the LIVE editor, not in isolation: every patch the form emits is
 * merged back into the node's data and the form re-renders with it
 * (`App.tsx:patchNode`). A blank row is not a credential request, so
 * `secretRowsOf` never returns one — a form that renders straight from stored
 * rows therefore makes "Add credential" appear to do nothing at all.
 */
describe('get-secret rows survive the editor round-trip', () => {
  /** The one-node edit panel: node data in, patch merged back in, re-render. */
  async function live(initial: Record<string, unknown>) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const t = (key: string) => (EDITOR_STRINGS.en as Record<string, string>)[key] ?? key
    function LiveForm() {
      const [data, setData] = useState<Record<string, unknown>>({
        blockId: 'get-secret',
        ...initial,
      })
      return createElement(EditGetSecret, {
        data,
        onChange: (patch: Record<string, unknown>) => {
          patches.push(patch)
          setData((current) => ({ ...current, ...patch }))
        },
        blockId: 'get-secret',
      } as never)
    }
    // The dropdown only exists once `listPasswords()` has resolved.
    await act(async () => {
      root.render(
        createElement(
          EditorLocaleContext.Provider,
          { value: makeEditorLocale('en', t) },
          createElement(LiveForm),
        ),
      )
    })
    return container
  }

  it('shows the row "Add credential" added', async () => {
    const container = await live({ credential: 'pat::token', variableName: 'token' })
    expect(rowsOf(container)).toHaveLength(1)
    click(textButton(container, 'Add credential'))
    expect(rowsOf(container)).toHaveLength(2)
    expect(selectsOf(container)).toHaveLength(2)
  })

  it('keeps a name typed into a row that has no credential yet', async () => {
    const container = await live({ credential: 'pat::token', variableName: 'token' })
    click(textButton(container, 'Add credential'))
    type(inputsOf(container)[1]!, 'githubToken')
    expect(inputsOf(container)[1]!.value).toBe('githubToken')
    // An unfinished row must not reach the node: a blank credential would be a
    // fetch the executor can only fail on.
    const stored = patches.at(-1)?.['credentials'] as { credential: string }[] | undefined
    expect((stored ?? []).every((row) => row.credential !== '')).toBe(true)
  })

  it('keeps the row when its credential is finally picked', async () => {
    const container = await live({ credential: 'pat::token', variableName: 'token' })
    click(textButton(container, 'Add credential'))
    pick(selectsOf(container)[1]!, 'pat::user name')
    expect(rowsOf(container)).toHaveLength(2)
    expect(selectsOf(container).map((s) => s.value)).toEqual(['pat::token', 'pat::user name'])
  })

  it('starts a fresh node with one blank row and still adds another', async () => {
    const container = await live({ credential: '', variableName: '' })
    expect(rowsOf(container)).toHaveLength(1)
    click(textButton(container, 'Add credential'))
    expect(rowsOf(container)).toHaveLength(2)
  })
})
