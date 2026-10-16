// @vitest-environment jsdom
/**
 * The conditions block's path editor: one row per output path, the always-drawn
 * fallback, and the modal that hosts a path's condition tree.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import EditConditions from '../src/workflow-editor/blocks/batchC/EditConditions'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'
import type { ConditionPath } from '../src/lib/workflow/condition-tree'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

const roots: Root[] = []
let patches: Record<string, unknown>[] = []

function path(id: string, name: string, groups = 1): ConditionPath {
  return {
    id,
    name,
    conditions: Array.from({ length: groups }, (_, i) => ({
      id: `g-${id}-${i}`,
      conditions: [],
    })),
  }
}

/** Mount the form over `data`; the container is where the path list lives. */
async function mountForm(paths?: unknown): Promise<HTMLDivElement> {
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
        createElement(EditConditions, {
          data: { blockId: 'conditions', ...(paths === undefined ? {} : { paths }) },
          onChange: (patch: Record<string, unknown>) => patches.push(patch),
          blockId: 'conditions',
        } as never),
      ),
    )
  })
  return container
}

function click(button: Element | undefined): void {
  if (!button) throw new Error('no such button')
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** The button whose accessible name is this English string (en locale → literal). */
function textButton(container: ParentNode, label: string): Element {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label || b.getAttribute('title') === label,
  )
  if (!button) throw new Error(`no button labelled ${label}`)
  return button
}

const rowsOf = (container: ParentNode): HTMLElement[] => [...container.querySelectorAll('li')]

/** Names currently in the form, top to bottom. */
const namesIn = (container: ParentNode): string[] =>
  rowsOf(container).map((row) => row.querySelector('input')?.value ?? '')

beforeEach(() => {
  patches = []
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('conditions block form · output paths', () => {
  it('lists one row per path plus the fallback port', async () => {
    const container = await mountForm([path('p1', 'Logged in'), path('p2', 'Cart ready')])
    expect(namesIn(container)).toEqual(['Logged in', 'Cart ready'])
    // The no-match port is stated explicitly, not left for the canvas to imply.
    expect(container.textContent).toContain('always present')
  })

  it('summarises a path with no condition groups as unconfigured', async () => {
    const container = await mountForm([path('p1', 'A', 0), path('p2', 'B', 2)])
    expect(container.textContent).toContain('No conditions yet')
    expect(container.textContent).toContain('2 condition groups')
  })

  it('prompts for a path when the block has none yet', async () => {
    const container = await mountForm(undefined)
    expect(rowsOf(container)).toHaveLength(0)
    expect(container.textContent).toContain('No paths yet')
  })

  it('writes the path list under `paths`, never the legacy `conditions`', async () => {
    const container = await mountForm([path('p1', 'A')])
    const input = rowsOf(container)[0]!.querySelector('input')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'Renamed',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(patches).toHaveLength(1)
    const written = patches[0]!['paths'] as ConditionPath[]
    expect(written[0]!.name).toBe('Renamed')
    expect(patches[0]).not.toHaveProperty('conditions')
  })

  it('appends a path and reorders it with the move buttons', async () => {
    const container = await mountForm([path('p1', 'A')])
    click(textButton(container, 'Add path'))
    const added = patches[0]!['paths'] as ConditionPath[]
    expect(added).toHaveLength(2)
    expect(added[1]!.id).not.toBe('p1')

    // Mount the two-path shape and push the first one down.
    patches = []
    const two = await mountForm([path('p1', 'A'), path('p2', 'B')])
    click(rowsOf(two)[0]!.querySelector('[title="Move down"]')!)
    expect((patches[0]!['paths'] as ConditionPath[]).map((p) => p.name)).toEqual(['B', 'A'])
  })
})

describe('conditions block form · condition modal', () => {
  it('opens the path condition tree in a dialog instead of inline', async () => {
    const container = await mountForm([path('p1', 'Logged in')])
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    click(rowsOf(container)[0]!.querySelector('[title="Edit conditions"]')!)

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    // The title names the path being edited, and the builder is inside it.
    expect(dialog!.textContent).toContain('Conditions · Logged in')
    expect(textButton(dialog!, 'AND')).toBeTruthy()
  })

  it("shows the path's stored rows in the dialog", async () => {
    const container = await mountForm([
      {
        id: 'p1',
        name: 'Logged in',
        conditions: [
          {
            id: 'g1',
            conditions: [
              {
                id: 'r1',
                items: [
                  { id: 'a', category: 'value', type: 'element', data: { selector: '#user' } },
                  { id: 'b', category: 'compare', type: 'eq' },
                  { id: 'c', category: 'value', type: 'value', data: { value: 'dcc' } },
                ],
              },
            ],
          },
        ],
      },
    ])
    click(rowsOf(container)[0]!.querySelector('[title="Edit conditions"]')!)
    const dialog = document.querySelector('[role="dialog"]')!
    const values = [...dialog.querySelectorAll('input')].map((input) => input.value)
    expect(values).toContain('#user')
    expect(values).toContain('dcc')
  })

  it('closes the dialog without touching the stored paths', async () => {
    const container = await mountForm([path('p1', 'Logged in')])
    click(rowsOf(container)[0]!.querySelector('[title="Edit conditions"]')!)
    click(textButton(document, 'Close'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(patches).toHaveLength(0)
  })
})

describe('conditions block form · deleting a path', () => {
  it('keeps the path when the confirm is declined', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const container = await mountForm([path('p1', 'A'), path('p2', 'B')])
    await act(async () => {
      rowsOf(container)[0]!.querySelector<HTMLElement>('[title="Delete path"]')!.click()
    })
    expect(patches).toHaveLength(0)
    confirmSpy.mockRestore()
  })

  it('drops the path once the confirm is accepted', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const container = await mountForm([path('p1', 'A'), path('p2', 'B')])
    await act(async () => {
      rowsOf(container)[0]!.querySelector<HTMLElement>('[title="Delete path"]')!.click()
    })
    await act(async () => {})
    expect((patches[0]!['paths'] as ConditionPath[]).map((p) => p.name)).toEqual(['B'])
    confirmSpy.mockRestore()
  })
})
