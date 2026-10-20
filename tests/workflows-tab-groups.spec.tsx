// @vitest-environment jsdom
/**
 * The Workflows tab's group sections and batch export.
 *
 * Two behaviors are worth pinning down, because both are easy to break
 * without noticing: the checked workflows are the ones that get exported, and
 * "move to group" files exactly the checked workflows (and nothing else).
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
import type { WorkflowGroup } from '../src/lib/workflow/groups'
import { messagesFor } from '../src/lib/i18n'
import { I18nProvider } from '../src/sidepanel/i18n'
import WorkflowsTab from '../src/sidepanel/WorkflowsTab'

const t = messagesFor('en')

function workflow(id: string, name: string, folderId?: string): Workflow {
  return {
    id,
    name,
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes: [], edges: [] },
    settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    ...(folderId ? { folderId } : {}),
  }
}

const group: WorkflowGroup = { id: 'g1', name: 'Daily', createdAt: 1, updatedAt: 1 }

let workflows: Workflow[] = []
const seen: Command[] = []
/** The JSON handed to the download helper, captured from the created blob. */
let downloaded: unknown = null

beforeEach(() => {
  workflows = [workflow('wf-1', 'Scrape leads', 'g1'), workflow('wf-2', 'Send report')]
  seen.length = 0
  downloaded = null
  mocks.sendCommand.mockReset()
  mocks.sendCommand.mockImplementation(async (command: Command): Promise<unknown> => {
    seen.push(command)
    switch (command.type) {
      case 'workflows.list':
        return { type: 'workflows.list', workflows }
      case 'tasks.runs':
        return { type: 'tasks.runs', runs: [] }
      case 'workflows.takeoverPending':
        return { type: 'workflows.takeoverPending', items: [] }
      case 'workflowGroups.list':
        return { type: 'workflowGroups.list', groups: [group] }
      case 'workflows.assignGroup':
        return { type: 'workflows.assignGroup' }
      case 'record.status':
        return { type: 'record.status', recording: false }
      default:
        throw new Error(`unexpected command: ${command.type}`)
    }
  })
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => path },
    storage: { onChanged: { addListener: () => {}, removeListener: () => {} } },
    windows: { create: vi.fn(), getCurrent: vi.fn(async () => ({ id: 1 })) },
    tabs: { create: vi.fn() },
  })
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob): string => {
      void blob.text().then((text) => {
        downloaded = JSON.parse(text)
      })
      return 'blob:mock'
    },
    revokeObjectURL: () => {},
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

const render = async (): Promise<HTMLElement> => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(
        I18nProvider,
        { value: { locale: 'en' as const, t } },
        createElement(WorkflowsTab),
      ),
    )
  })
  await flush()
  return container
}

function checkboxes(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
}

describe('workflow groups', () => {
  it('lists the group and the ungrouped workflows separately', async () => {
    const container = await render()
    expect(container.textContent).toContain('Daily')
    expect(container.textContent).toContain(t.workflowsUngrouped)
    expect(container.textContent).toContain('Scrape leads')
    expect(container.textContent).toContain('Send report')
  })

  it('exports exactly the checked workflows', async () => {
    const container = await render()
    const boxes = checkboxes(container)
    // The first box is "select all"; the second belongs to the first workflow.
    await act(async () => boxes[1]?.click())
    await flush()

    const exportButton = container.querySelector(`[aria-label="${t.workflowsBatchExport}"]`)
    expect(exportButton).not.toBeNull()
    await act(async () => (exportButton as HTMLElement).click())
    await flush()

    const exported = downloaded as { id: string }[]
    expect(exported.map((wf) => wf.id)).toEqual(['wf-1'])
  })

  it('files the checked workflows into the chosen group', async () => {
    const container = await render()
    const boxes = checkboxes(container)
    await act(async () => boxes[1]?.click())
    await flush()

    const moveButton = container.querySelector(`[aria-label="${t.workflowsMoveToGroup}"]`)
    expect(moveButton).not.toBeNull()
    await act(async () => (moveButton as HTMLElement).click())
    await flush()

    const menuItem = [...container.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent?.includes('Daily'),
    )
    expect(menuItem).toBeDefined()
    await act(async () => (menuItem as HTMLElement).click())
    await flush()

    const assign = seen.find(
      (command): command is Extract<Command, { type: 'workflows.assignGroup' }> =>
        command.type === 'workflows.assignGroup',
    )
    expect(assign?.ids).toEqual(['wf-1'])
    expect(assign?.groupId).toBe('g1')
  })
})
