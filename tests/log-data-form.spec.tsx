// @vitest-environment jsdom
/**
 * The log-data block picks its source workflow from a dropdown of saved
 * workflows (Automa parity) instead of asking for a pasted id.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import EditLogData from '../src/workflow-editor/blocks/batchC/EditLogData'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn() }))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

const roots: Root[] = []
let patches: Record<string, unknown>[] = []

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

async function mountForm(data: Record<string, unknown>): Promise<HTMLDivElement> {
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
        createElement(EditLogData, {
          data,
          onChange: (patch: Record<string, unknown>) => patches.push(patch),
          blockId: 'log-data',
        } as never),
      ),
    )
  })
  await flush()
  return container
}

beforeEach(() => {
  patches = []
  mocks.sendCommand.mockReset()
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('log-data workflow picker', () => {
  it('lists saved workflows by name and writes the picked id', async () => {
    mocks.sendCommand.mockResolvedValue({
      type: 'workflows.list',
      workflows: [
        { id: 'wf-1', name: 'Morning digest' },
        { id: 'wf-2', name: 'Crawl the shop' },
      ],
    })

    const container = await mountForm({ workflowId: 'wf-2' })
    const select = container.querySelector('select')!
    expect(select).not.toBeNull()
    const labels = [...select.options].map((option) => option.textContent?.trim())
    expect(labels).toContain('Morning digest')
    expect(labels).toContain('Crawl the shop')
    expect(select.value).toBe('wf-2')

    act(() => {
      select.value = 'wf-1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(patches).toEqual([{ workflowId: 'wf-1' }])
  })

  it('keeps a stored id that no longer resolves instead of rewriting it', async () => {
    mocks.sendCommand.mockResolvedValue({ type: 'workflows.list', workflows: [] })

    const container = await mountForm({ workflowId: 'deleted-wf' })
    const select = container.querySelector('select')!
    expect([...select.options].some((option) => option.value === 'deleted-wf')).toBe(true)
    expect(select.value).toBe('deleted-wf')
  })
})
