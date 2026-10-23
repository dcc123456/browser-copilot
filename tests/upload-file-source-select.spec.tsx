// @vitest-environment jsdom
/**
 * The `upload-file` source picker is a dropdown, matching `parse-excel`.
 *
 * The form also renders the shared selector control, whose find-by dialect is a
 * second <select>; the source dropdown is therefore identified by its options
 * rather than by being the only select on the page.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import EditUploadFile from '../src/workflow-editor/blocks/batchA/EditUploadFile'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

const roots: Root[] = []
let patches: Record<string, unknown>[] = []

async function mount(data: Record<string, unknown> = {}): Promise<HTMLDivElement> {
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
        createElement(EditUploadFile, {
          data: { blockId: 'upload-file', ...data },
          onChange: (patch: Record<string, unknown>) => patches.push(patch),
          blockId: 'upload-file',
        } as never),
      ),
    )
  })
  return container
}

function sourceSelectOf(container: HTMLElement): HTMLSelectElement {
  const select = [...container.querySelectorAll('select')].find((candidate) =>
    [...candidate.options].some((option) => option.value === 'user-select'),
  )
  if (!select) throw new Error('no upload-source dropdown')
  return select
}

function pick(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

beforeEach(() => {
  patches = []
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('upload-file source picker', () => {
  it('renders the source modes as one dropdown, not radios', async () => {
    const container = await mount()
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0)
    expect([...sourceSelectOf(container).options].map((option) => option.value)).toEqual([
      'user-select',
      'workflow-file',
      'latest-download',
      'file-path',
    ])
  })

  it('writes the picked mode back as a sourceMode patch', async () => {
    pick(sourceSelectOf(await mount()), 'latest-download')
    expect(patches.at(-1)).toEqual({ sourceMode: 'latest-download' })
  })

  it('shows the file-path controls only for that mode', async () => {
    const container = await mount({ sourceMode: 'file-path' })
    expect(sourceSelectOf(container).value).toBe('file-path')
    expect(container.textContent).toContain('Browse downloads')
  })
})
