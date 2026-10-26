// @vitest-environment jsdom
/**
 * Workflow sidebar header: the unsaved marker plus the rename dialog moved out
 * of the top toolbar.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import WorkflowSidebarHeader from '../src/workflow-editor/sidebar/WorkflowSidebarHeader'
import { EDITOR_STRINGS } from '../src/workflow-editor/i18n'
import { EditorLocaleContext, makeEditorLocale } from '../src/workflow-editor/locale-context'
import { copyText } from '../src/lib/clipboard'

vi.mock('../src/lib/clipboard', () => ({ copyText: vi.fn() }))

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

const roots: Root[] = []

async function mount(
  onRename: (name: string) => void,
  { dirty = false, workflowId = 'wf-123' }: { dirty?: boolean; workflowId?: string | null } = {},
): Promise<HTMLDivElement> {
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
        createElement(WorkflowSidebarHeader, {
          workflowId,
          workflowName: 'My workflow',
          workflowIcon: '',
          dirty,
          onRename,
        }),
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

function type(el: HTMLInputElement, next: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, next)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function openRename(container: HTMLElement): HTMLInputElement {
  click(container.querySelector('button[title="Rename workflow"]') ?? undefined)
  const input = document.querySelector<HTMLInputElement>('.wf-rename-input')
  if (!input) throw new Error('rename dialog did not open')
  return input
}

function saveRename(): void {
  const action = document.querySelector('.wf-rename-actions')
  click(action?.querySelectorAll('button')[1])
}

afterEach(() => {
  vi.mocked(copyText).mockReset()
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('workflow sidebar header', () => {
  it('marks unsaved changes', async () => {
    const container = await mount(vi.fn(), { dirty: true })
    expect(container.querySelector('[title="Unsaved changes"]')).not.toBeNull()
  })

  it('copies the workflow id and confirms it', async () => {
    vi.mocked(copyText).mockResolvedValue(undefined)
    const container = await mount(vi.fn(), { workflowId: 'wf-copy-me' })
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy workflow ID"]',
    )
    expect(button).not.toBeNull()
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(copyText).toHaveBeenCalledWith('wf-copy-me')
    expect(button!.getAttribute('aria-label')).toBe('Workflow ID copied')
  })

  it('says so when the clipboard refuses', async () => {
    vi.mocked(copyText).mockRejectedValue(new Error('refused'))
    const container = await mount(vi.fn(), { workflowId: 'wf-copy-me' })
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy workflow ID"]',
    )
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('Copy failed')
    expect(button!.getAttribute('aria-label')).toBe(
      'Copy failed — select the ID and copy it manually',
    )
  })

  it('disables the copy button until the id has loaded', async () => {
    const container = await mount(vi.fn(), { workflowId: null })
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy workflow ID"]',
    )
    expect(button?.disabled).toBe(true)
  })

  it('renames through the dialog', async () => {
    const onRename = vi.fn()
    const container = await mount(onRename)
    type(openRename(container), 'New name')
    saveRename()
    expect(onRename).toHaveBeenCalledWith('New name')
  })

  it('ignores an empty draft', async () => {
    const onRename = vi.fn()
    const container = await mount(onRename)
    type(openRename(container), '   ')
    saveRename()
    expect(onRename).not.toHaveBeenCalled()
    expect(document.querySelector('.wf-rename-input')).toBeNull()
  })
})
