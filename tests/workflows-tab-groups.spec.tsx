// @vitest-environment jsdom
/**
 * The Workflows tab's group sections: folding, per-card filing, drag order and
 * batch export.
 *
 * The checks worth pinning down are the ones that break silently: which
 * workflows a batch action touches, what the first render leaves expanded, and
 * which control renames a group versus folding it.
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
const secondGroup: WorkflowGroup = { id: 'g2', name: 'Weekly', createdAt: 2, updatedAt: 2 }

let workflows: Workflow[] = []
let groups: WorkflowGroup[] = []
const seen: Command[] = []
/** Editor popup creations, so a group's "new workflow" target can be asserted. */
const windowsCreate = vi.fn()
/** The JSON handed to the download helper, captured from the created blob. */
let downloaded: unknown = null
const mountedRoots: Root[] = []

beforeEach(() => {
  workflows = [workflow('wf-1', 'Scrape leads', 'g1'), workflow('wf-2', 'Send report')]
  groups = [group]
  seen.length = 0
  downloaded = null
  windowsCreate.mockReset()
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
        return { type: 'workflowGroups.list', groups }
      case 'workflowGroups.reorder':
        return {
          type: 'workflowGroups.reorder',
          groups: command.ids
            .map((id) => groups.find((entry) => entry.id === id))
            .filter((entry): entry is WorkflowGroup => !!entry),
        }
      case 'workflows.assignGroup':
        return { type: 'workflows.assignGroup' }
      case 'workflowGroups.delete':
        return { type: 'workflowGroups.delete' }
      case 'record.status':
        return { type: 'record.status', recording: false }
      default:
        throw new Error(`unexpected command: ${command.type}`)
    }
  })
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => path },
    storage: { onChanged: { addListener: () => {}, removeListener: () => {} } },
    windows: { create: windowsCreate, getCurrent: vi.fn(async () => ({ id: 1 })) },
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

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount()
  })
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
  mountedRoots.push(root)
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

function sections(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('section')]
}

/** The chevron is the first `aria-expanded` control in each section header. */
function foldButtons(container: HTMLElement): HTMLElement[] {
  return sections(container).map(
    (section) => section.querySelector<HTMLElement>('button[aria-expanded]') as HTMLElement,
  )
}

function sectionTitled(container: HTMLElement, title: string): HTMLElement {
  const section = sections(container).find((node) => node.textContent?.includes(title))
  if (!section) throw new Error(`no section titled ${title}`)
  return section
}

function click(node: Element | null | undefined): Promise<void> {
  if (!node) throw new Error('nothing to click')
  return act(async () => {
    ;(node as HTMLElement).click()
  })
}

function dispatch(target: Element, type: string): Promise<void> {
  return act(async () => {
    target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))
  })
}

describe('workflow groups', () => {
  it('renders every group section, expanding only the first one', async () => {
    workflows = [...workflows, workflow('wf-3', 'Weekly digest', 'g2')]
    groups = [group, secondGroup]
    const container = await render()

    expect(container.textContent).toContain('Daily')
    expect(container.textContent).toContain('Weekly')
    expect(container.textContent).toContain(t.workflowsUngrouped)
    expect(container.textContent).toContain('Scrape leads')
    expect(container.textContent).not.toContain('Weekly digest')
    expect(container.textContent).not.toContain('Send report')
    expect(foldButtons(container).map((node) => node.getAttribute('aria-expanded'))).toEqual([
      'true',
      'false',
      'false',
    ])
  })

  it('folds and unfolds the ungrouped bucket without touching the groups above it', async () => {
    const container = await render()
    // Sections render groups first, then the ungrouped bucket.
    const toggles = foldButtons(container)
    const ungroupedToggle = toggles.at(-1)
    expect(ungroupedToggle?.getAttribute('aria-expanded')).toBe('false')

    await click(ungroupedToggle)
    await flush()
    expect(container.textContent).toContain('Send report')
    expect(ungroupedToggle?.getAttribute('aria-expanded')).toBe('true')
    expect(toggles[0]?.getAttribute('aria-expanded')).toBe('true')

    await click(ungroupedToggle)
    await flush()
    expect(container.textContent).not.toContain('Send report')
    expect(toggles[0]?.getAttribute('aria-expanded')).toBe('true')
  })

  it('opens a new workflow from the group header, filed into that group', async () => {
    const container = await render()
    const daily = sectionTitled(container, 'Daily')
    await click(daily.querySelector(`[aria-label="${t.workflowsGroupNewWorkflow}"]`))
    await flush()

    expect(windowsCreate).toHaveBeenCalledTimes(1)
    const created = windowsCreate.mock.calls[0]?.[0] as { url: string; type: string }
    expect(created.type).toBe('popup')
    // No `edit`: the editor assigns the id, and takes the group from `folder`.
    expect(created.url).toBe('src/workflow-editor/index.html?folder=g1&hostWindow=1')
  })

  it('keeps a group visible before it holds any workflow', async () => {
    workflows = []
    groups = [group]
    const container = await render()

    expect(container.textContent).not.toContain(t.workflowsEmpty)
    const daily = sectionTitled(container, 'Daily')
    expect(daily.querySelector(`[aria-label="${t.workflowsGroupNewWorkflow}"]`)).not.toBeNull()
    await click(daily.querySelector(`[aria-label="${t.workflowsGroupNewWorkflow}"]`))
    await flush()
    const created = windowsCreate.mock.calls[0]?.[0] as { url: string }
    expect(created.url).toContain('folder=g1')
  })

  it('folds a group when its name is clicked and renames only from the pencil', async () => {
    const container = await render()
    const daily = sectionTitled(container, 'Daily')
    const toggle = daily.querySelector<HTMLElement>('button[aria-expanded]')

    await click([...daily.querySelectorAll('button')].find((node) => node.textContent === 'Daily'))
    await flush()
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toContain('Scrape leads')
    expect(daily.querySelector('input')).toBeNull()

    await click([...daily.querySelectorAll('button')].find((node) => node.textContent === 'Daily'))
    await flush()
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Scrape leads')

    await click(daily.querySelector(`[aria-label="${t.workflowsGroupRename}"]`))
    await flush()
    const input = daily.querySelector<HTMLInputElement>('input')
    expect(input?.value).toBe('Daily')
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
  })

  it('files a single workflow through its own card menu', async () => {
    const container = await render()
    const card = container.querySelector('[data-workflow-id="wf-1"]')
    expect(card).not.toBeNull()
    const trigger = [...(card as HTMLElement).querySelectorAll('button')].find(
      (node) => node.textContent === t.workflowsMoveToGroupSingle,
    )
    await click(trigger)
    await flush()

    const menu = (card as HTMLElement).querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    const ungroupedItem = [...(menu as HTMLElement).querySelectorAll('[role="menuitem"]')].find(
      (node) => node.textContent === t.workflowsMoveToUngrouped,
    )
    await click(ungroupedItem)
    await flush()

    const assign = seen.find(
      (command): command is Extract<Command, { type: 'workflows.assignGroup' }> =>
        command.type === 'workflows.assignGroup',
    )
    expect(assign?.ids).toEqual(['wf-1'])
    expect(assign?.groupId).toBeNull()
  })

  it('reorders groups when one is dragged onto another', async () => {
    groups = [group, secondGroup]
    const container = await render()
    const [daily, weekly] = sections(container)
    const handles = [daily, weekly].map((section) =>
      section?.querySelector('button[draggable="true"]'),
    )
    expect(handles[1]).toBeTruthy()

    await dispatch(handles[1] as Element, 'dragstart')
    await dispatch(daily as HTMLElement, 'dragover')
    await dispatch(daily as HTMLElement, 'drop')
    await flush()

    const reorder = seen.find(
      (command): command is Extract<Command, { type: 'workflowGroups.reorder' }> =>
        command.type === 'workflowGroups.reorder',
    )
    expect(reorder?.ids).toEqual(['g2', 'g1'])
    expect(sections(container)[0]?.textContent).toContain('Weekly')
    expect(sections(container)[1]?.textContent).toContain('Daily')
  })

  it('exports exactly the checked workflows', async () => {
    const container = await render()
    const boxes = checkboxes(container)
    // The first box is "select all"; the second belongs to the first workflow.
    await click(boxes[1])
    await flush()

    const exportButton = container.querySelector(`[aria-label="${t.workflowsBatchExport}"]`)
    expect(exportButton).not.toBeNull()
    await click(exportButton)
    await flush()

    const exported = downloaded as { id: string }[]
    expect(exported.map((wf) => wf.id)).toEqual(['wf-1'])
  })

  it('files the checked workflows into the chosen group', async () => {
    const container = await render()
    const boxes = checkboxes(container)
    await click(boxes[1])
    await flush()

    const moveButton = container.querySelector(`[aria-label="${t.workflowsMoveToGroup}"]`)
    expect(moveButton).not.toBeNull()
    await click(moveButton)
    await flush()

    const menuItem = [...container.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent?.includes('Daily'),
    )
    expect(menuItem).toBeDefined()
    await click(menuItem)
    await flush()

    const assign = seen.find(
      (command): command is Extract<Command, { type: 'workflows.assignGroup' }> =>
        command.type === 'workflows.assignGroup',
    )
    expect(assign?.ids).toEqual(['wf-1'])
    expect(assign?.groupId).toBe('g1')
  })

  it('confirms with the member count before deleting a group and its workflows', async () => {
    const container = await render()
    const prompts: string[] = []
    const confirmSpy = vi.spyOn(window, 'confirm').mockImplementation((message?: string) => {
      if (message) prompts.push(message)
      return true
    })
    try {
      const daily = sectionTitled(container, 'Daily')
      const deleteButton = daily.querySelector(`[aria-label="${t.workflowsGroupDelete}"]`)
      await click(deleteButton)
      await flush()
    } finally {
      confirmSpy.mockRestore()
    }

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Daily')
    expect(prompts[0]).toContain('1 workflow')
    expect(seen.find((command) => command.type === 'workflowGroups.delete')).toEqual({
      type: 'workflowGroups.delete',
      id: 'g1',
    })
  })

  it('keeps the group when the deletion prompt is dismissed', async () => {
    const container = await render()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      const daily = sectionTitled(container, 'Daily')
      await click(daily.querySelector(`[aria-label="${t.workflowsGroupDelete}"]`))
      await flush()
    } finally {
      confirmSpy.mockRestore()
    }

    expect(seen.some((command) => command.type === 'workflowGroups.delete')).toBe(false)
  })
})
