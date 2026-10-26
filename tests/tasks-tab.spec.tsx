// @vitest-environment jsdom
/**
 * Component tests for the tasks tab (`sidepanel/TasksTab`), driving the real
 * component with a mocked command channel. Pins the two contracts the tab owes
 * the user:
 *
 * 1. a task written elsewhere shows up without reopening the panel. Every panel
 *    tab stays mounted (App.tsx), so the list only stays current because the tab
 *    listens on the store-change bus for the `scheduledTasks` key — which is what
 *    `create_scheduled_task` in a chat turn, and each scheduled run recording its
 *    result, write through.
 * 2. 编辑 opens the shared modal (role=dialog) instead of expanding an inline
 *    form above the list, saves through `tasks.save`, and cancels without saving.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn() }))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom has no scrolling API; saving a task flashes the row, which scrolls it into view.
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: () => {},
    configurable: true,
  })
})

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Command } from '../src/lib/messages'
import { describeSchedule } from '../src/lib/schedule'
import { EMPTY_FEISHU_CONFIG, type Schedule, type ScheduledTask } from '../src/lib/scheduler-types'
import type { Workflow } from '../src/lib/workflow/types'
import { messagesFor } from '../src/lib/i18n'
import { I18nProvider } from '../src/sidepanel/i18n'
import TasksTab from '../src/sidepanel/TasksTab'
import { notifyStoreChanged } from '../src/lib/store-events'

const t = messagesFor('en')

let tasks: ScheduledTask[] = []
const seen: Command[] = []

function task(id: string, name: string, prompt = `prompt of ${name}`): ScheduledTask {
  return {
    id,
    name,
    enabled: true,
    schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
    kind: 'agent-prompt',
    prompt,
    maxToolRounds: 40,
    notifyFeishu: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

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

/** Commands of one type the tab sent so far. */
const commands = (type: Command['type']): Command[] => seen.filter((entry) => entry.type === type)

beforeEach(() => {
  tasks = [task('t-1', 'Morning digest')]
  seen.length = 0
  mocks.sendCommand.mockReset()
  mocks.sendCommand.mockImplementation(async (command: Command): Promise<unknown> => {
    seen.push(command)
    switch (command.type) {
      case 'tasks.list':
        return { type: 'tasks.list', tasks }
      case 'feishu.get':
        return { type: 'feishu.get', config: EMPTY_FEISHU_CONFIG }
      case 'workflows.list':
        return { type: 'workflows.list', workflows: [workflow('wf-1', 'Read page')] }
      case 'tasks.save':
        tasks = [command.task, ...tasks.filter((entry) => entry.id !== command.task.id)]
        return { type: 'tasks.save' }
      default:
        throw new Error(`unexpected command: ${command.type}`)
    }
  })
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: () => {}, removeListener: () => {} },
    },
    storage: { onChanged: { addListener: () => {}, removeListener: () => {} } },
    windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
  })
})

afterEach(() => {
  // Unmount while `document` still exists: the save-flash effect leaves a 60ms
  // scroll timer behind, and one left pending fires into the torn-down jsdom
  // as an unhandled error when the file's environment goes away.
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount()
    })
  }
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const roots: Root[] = []

const render = async (): Promise<{ container: HTMLElement; root: Root }> => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      createElement(I18nProvider, { value: { locale: 'en' as const, t } }, createElement(TasksTab)),
    )
  })
  await flush()
  return { container, root }
}

const click = async (root: ParentNode, label: string): Promise<void> => {
  const button = [...root.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!button) throw new Error(`no button labelled ${label}`)
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

/** Clicks a button whose label carries a leading marker (`+ New task`). */
const clickEnding = async (root: ParentNode, label: string): Promise<void> => {
  const button = [...root.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.trim().endsWith(label),
  )
  if (!button) throw new Error(`no button ending in ${label}`)
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

/** The "new task" button carries a leading `+`, so it matches by suffix. */
const clickCreating = (container: HTMLElement): Promise<void> => clickEnding(container, t.taskNew)

/** The open modal, if any — `FormDialog` renders in place, not through a portal. */
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]')

describe('tasks tab · live refresh', () => {
  it('shows a task created after the panel mounted', async () => {
    const { container } = await render()
    expect(container.textContent).toContain('Morning digest')
    const listsBefore = commands('tasks.list').length

    // The chat turn's `create_scheduled_task` wrote through the same key.
    tasks = [task('t-2', 'Nightly cleanup'), ...tasks]
    await act(async () => {
      notifyStoreChanged('scheduledTasks')
    })
    await flush()

    expect(commands('tasks.list').length).toBe(listsBefore + 1)
    expect(container.textContent).toContain('Nightly cleanup')
  })

  it('does not re-list on a store change to another key', async () => {
    await render()
    const listsBefore = commands('tasks.list').length

    await act(async () => {
      notifyStoreChanged('workflows')
      notifyStoreChanged('settings')
    })
    await flush()

    expect(commands('tasks.list').length).toBe(listsBefore)
  })
})

describe('tasks tab · editing opens a dialog', () => {
  it('carries the stored values into a modal and saves through tasks.save', async () => {
    const { container } = await render()
    expect(dialog()).toBeNull()

    await click(container, t.edit)

    const panel = dialog()
    expect(panel).not.toBeNull()
    expect(panel?.getAttribute('aria-label')).toBe('Morning digest')
    expect(panel?.textContent).toContain('Morning digest')
    // The prompt of the stored task is what the form shows, not an empty draft.
    const textarea = panel?.querySelector('textarea')
    expect(textarea?.value).toBe('prompt of Morning digest')
    // No inline editor card is left expanding the list behind the modal.
    expect(container.querySelector('.card.task-editor')).toBeNull()

    await click(panel!, t.taskSave)

    const saves = commands('tasks.save')
    expect(saves).toHaveLength(1)
    expect(saves[0]).toMatchObject({ type: 'tasks.save', task: { id: 't-1' } })
    expect(dialog()).toBeNull()
  })

  it('cancels without sending tasks.save', async () => {
    const { container } = await render()
    await click(container, t.edit)
    expect(dialog()).not.toBeNull()

    await click(dialog()!, t.cancel)

    expect(commands('tasks.save')).toHaveLength(0)
    expect(dialog()).toBeNull()
  })

  it('creates a new task in the same dialog', async () => {
    const { container } = await render()
    await clickCreating(container)

    const panel = dialog()
    expect(panel).not.toBeNull()
    // An unnamed draft is titled by the action, not by an empty name.
    expect(panel?.getAttribute('aria-label')).toBe(t.taskNew)
    // Nothing to save yet: the name is what gates the primary button.
    const save = [...(panel?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === t.taskSave,
    )
    expect(save?.hasAttribute('disabled')).toBe(true)
  })

  it('keeps the list actions disabled while the dialog is open', async () => {
    const { container } = await render()
    await click(container, t.edit)
    expect(dialog()).not.toBeNull()

    const run = container.querySelector<HTMLButtonElement>('button.task-action-run')
    expect(run?.hasAttribute('disabled')).toBe(true)
  })
})

describe('tasks tab · multiple trigger methods', () => {
  const weekly: Schedule = { kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }

  const savedTask = (): ScheduledTask => {
    const save = commands('tasks.save')[0]
    if (!save || save.type !== 'tasks.save') throw new Error('no tasks.save command')
    return save.task
  }

  it('shows one chip per trigger method', async () => {
    tasks = [
      {
        ...task('t-multi', 'Two cadences'),
        schedule: weekly,
        schedules: [weekly, { kind: 'interval', minutes: 30 }],
      },
    ]
    const { container } = await render()

    const chips = [...container.querySelectorAll('.task-meta .task-chip')].map((chip) =>
      chip.textContent?.trim(),
    )
    expect(chips).toContain(describeSchedule(weekly, 'en'))
    expect(chips).toContain(describeSchedule({ kind: 'interval', minutes: 30 }, 'en'))
  })

  it('adds a method card and saves the whole list', async () => {
    const { container } = await render()
    await click(container, t.edit)
    const panel = dialog()!
    expect(panel.querySelectorAll('[data-schedule-index]')).toHaveLength(1)

    await clickEnding(panel, t.taskScheduleAdd)

    expect(panel.querySelectorAll('[data-schedule-index]')).toHaveLength(2)
    const added = panel.querySelector<HTMLSelectElement>('[data-schedule-index="1"] select')
    expect(added?.value).toBe('interval')

    await click(panel, t.taskSave)

    const saved = savedTask()
    expect(saved.schedules).toEqual([weekly, { kind: 'interval', minutes: 60 }])
    // The legacy mirror follows the first method, not the one just added.
    expect(saved.schedule).toEqual(weekly)
  })

  it('removes a method card and saves the shortened list', async () => {
    tasks = [
      {
        ...task('t-multi', 'Two cadences'),
        schedule: weekly,
        schedules: [weekly, { kind: 'interval', minutes: 30 }],
      },
    ]
    const { container } = await render()
    await click(container, t.edit)
    const panel = dialog()!
    expect(panel.querySelectorAll('[data-schedule-index]')).toHaveLength(2)

    await click(panel, t.taskScheduleRemove)

    expect(panel.querySelectorAll('[data-schedule-index]')).toHaveLength(1)
    await click(panel, t.taskSave)

    const saved = savedTask()
    expect(saved.schedules).toEqual([{ kind: 'interval', minutes: 30 }])
    expect(saved.schedule).toEqual({ kind: 'interval', minutes: 30 })
  })
})
