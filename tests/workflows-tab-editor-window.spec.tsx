// @vitest-environment jsdom
/**
 * Component test for the Edit action on a workflow card
 * (`sidepanel/WorkflowsTab`): a workflow gets at most one editor window.
 *
 * Clicking Edit while the same workflow's editor is already open must focus
 * that window — opening a second one would put two independent copies of the
 * same graph on screen, and whichever saved last would silently win. A
 * workflow with no open editor still opens a fresh popup, and a chrome.windows
 * that cannot enumerate falls back to the old behaviour instead of doing
 * nothing.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn() }))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Command } from '../src/lib/messages'
import type { Workflow } from '../src/lib/workflow/types'
import { messagesFor } from '../src/lib/i18n'
import { I18nProvider } from '../src/sidepanel/i18n'
import WorkflowsTab from '../src/sidepanel/WorkflowsTab'

function workflow(id: string, name: string): Workflow {
  return {
    id,
    name,
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes: [], edges: [] },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
  }
}

/** The editor URL shape `openEditor` builds, with `chrome.runtime.getURL` stubbed as identity. */
const editorUrlFor = (id: string, hostWindow = 3): string =>
  `src/workflow-editor/index.html?edit=${id}&hostWindow=${hostWindow}`

type ChromeStub = {
  windows: {
    create: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    getCurrent: ReturnType<typeof vi.fn>
    getAll: ReturnType<typeof vi.fn>
  }
  tabs: {
    create: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  openWindows?: unknown[]
}

let chromeStub: ChromeStub

beforeEach(() => {
  mocks.sendCommand.mockReset()
  mocks.sendCommand.mockImplementation(async (command: Command): Promise<unknown> => {
    switch (command.type) {
      case 'workflows.list':
        return { type: 'workflows.list', workflows: [workflow('wf-1', 'Scrape leads')] }
      case 'tasks.runs':
        return { type: 'tasks.runs', runs: [] }
      case 'workflows.takeoverPending':
        return { type: 'workflows.takeoverPending', items: [] }
      case 'record.status':
        return { type: 'record.status', recording: false }
      default:
        throw new Error(`unexpected command: ${command.type}`)
    }
  })
  chromeStub = {
    windows: {
      create: vi.fn(async () => ({ id: 9 })),
      update: vi.fn(async () => ({})),
      getCurrent: vi.fn(async () => ({ id: 3 })),
      // `getAll` answers with the open windows of this test; `populate: true`
      // means each entry carries its tabs.
      getAll: vi.fn(async () => chromeStub.openWindows ?? []),
    },
    tabs: { create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
  }
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => path },
    storage: { onChanged: { addListener: () => {}, removeListener: () => {} } },
    windows: chromeStub.windows,
    tabs: chromeStub.tabs,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const render = async (): Promise<{ container: HTMLElement; root: Root }> => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(
        I18nProvider,
        { value: { locale: 'en' as const, t: messagesFor('en') } },
        createElement(WorkflowsTab),
      ),
    )
  })
  await flush()
  return { container, root }
}

const clickEdit = async (container: HTMLElement): Promise<void> => {
  const editButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === messagesFor('en').workflowsEdit,
  )
  expect(editButton).toBeDefined()
  await act(async () => {
    editButton?.click()
  })
  await flush()
}

describe('workflow editor window', () => {
  it('focuses the already-open editor window instead of stacking a second one', async () => {
    chromeStub.openWindows = [{ id: 7, tabs: [{ id: 70, url: editorUrlFor('wf-1') }] }]
    const { container } = await render()

    await clickEdit(container)

    expect(chromeStub.windows.update).toHaveBeenCalledWith(7, { focused: true })
    expect(chromeStub.tabs.update).toHaveBeenCalledWith(70, { active: true })
    expect(chromeStub.windows.create).not.toHaveBeenCalled()
    expect(chromeStub.tabs.create).not.toHaveBeenCalled()
  })

  it('opens a new editor window when only another workflow is open', async () => {
    chromeStub.openWindows = [{ id: 7, tabs: [{ id: 70, url: editorUrlFor('wf-2') }] }]
    const { container } = await render()

    await clickEdit(container)

    expect(chromeStub.windows.update).not.toHaveBeenCalled()
    expect(chromeStub.windows.create).toHaveBeenCalledTimes(1)
    const created = chromeStub.windows.create.mock.calls[0]?.[0] as { url: string; type: string }
    expect(created.type).toBe('popup')
    expect(created.url).toContain('edit=wf-1')
  })

  it('still opens an editor when the windows API cannot be enumerated', async () => {
    // Environments without chrome.windows.getAll must not end up doing
    // nothing: the fallback is the plain create path.
    chromeStub.windows.getAll = vi.fn(async () => {
      throw new Error('windows API unavailable')
    })
    const { container } = await render()

    await clickEdit(container)

    expect(chromeStub.windows.create).toHaveBeenCalledTimes(1)
  })
})
