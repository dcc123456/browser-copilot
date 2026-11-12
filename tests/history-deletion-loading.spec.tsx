// @vitest-environment jsdom
/**
 * Deleting from the History tab must look like work, not like a freeze
 * (`sidepanel/HistoryTab`).
 *
 * A delete is a round trip to the service worker plus a reload of the list, and
 * with the retention caps raised it can take a visible moment. Before this the
 * buttons stayed live, so the user clicked again — deleting rows that are
 * already gone, or interleaving a clear with a per-row delete. Every
 * destructive control of a section now shares one `useDeletion` latch: while it
 * is held the batch label reads "Deleting…", the controls are disabled, and a
 * re-entrant click is ignored rather than queued.
 *
 * The command channel is mocked with a deferred promise, which is the only
 * reliable way to observe the in-flight window in jsdom.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn() }))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})

// The batch/clear handlers gate on a confirm dialog. Answering it is not what
// these tests pin down, and without a <ConfirmHost> the call would fall through
// to jsdom's `window.confirm`, which is not implemented.
vi.mock('../src/ui/confirm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/confirm')>()
  return { ...actual, confirmDialog: vi.fn(async () => true) }
})

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Command } from '../src/lib/messages'
import type { ConversationMeta, HistoryEntry } from '../src/lib/types'
import type { TaskRunLog } from '../src/lib/scheduler-types'
import { messagesFor } from '../src/lib/i18n'
import { I18nProvider } from '../src/sidepanel/i18n'
import HistoryTab from '../src/sidepanel/HistoryTab'

const t = messagesFor('en')

/** Resolves only when the test lets it, so the in-flight state is observable. */
let pendingDelete: { promise: Promise<unknown>; settle: () => void } = settleLater()

function settleLater(): { promise: Promise<unknown>; settle: () => void } {
  let settle = (): void => {}
  const promise = new Promise<unknown>((resolve) => {
    settle = () => resolve(undefined)
  })
  return { promise, settle }
}

let conversations: ConversationMeta[] = []
let runs: TaskRunLog[] = []
let operations: HistoryEntry[] = []
/** How many destructive commands actually reached the worker. */
let deleteCalls = 0

function conversation(id: string): ConversationMeta {
  return { id, title: id, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }
}

function run(id: string): TaskRunLog {
  return {
    id,
    label: id,
    source: 'schedule',
    trigger: 'schedule',
    at: 1_700_000_000_000,
    ok: true,
    skipped: false,
    summary: `${id} finished`,
  }
}

function operation(id: string): HistoryEntry {
  return {
    id,
    at: 1_700_000_000_000,
    conversationId: 'c-1',
    action: 'click',
    summary: `${id} clicked a button`,
    approved: true,
    ok: true,
  }
}

/** A command that removes records, of any section. */
const DESTRUCTIVE = new Set<string>([
  'conversations.delete',
  'tasks.runs.delete',
  'tasks.runs.clear',
  'history.delete',
  'history.clear',
])

beforeEach(() => {
  conversations = [conversation('c-1'), conversation('c-2')]
  runs = [run('r-1'), run('r-2')]
  operations = [operation('h-1'), operation('h-2')]
  deleteCalls = 0
  pendingDelete = settleLater()
  mocks.sendCommand.mockReset()
  mocks.sendCommand.mockImplementation(async (command: Command): Promise<unknown> => {
    if (DESTRUCTIVE.has(command.type)) deleteCalls += 1
    switch (command.type) {
      case 'conversations.list':
        return { type: 'conversations.list', conversations }
      case 'tasks.runs':
        return { type: 'tasks.runs', runs }
      case 'history.list':
        return { type: 'history.list', entries: operations }
      case 'tasks.running':
        return { type: 'tasks.running', runs: [], finished: [] }
      default:
        return pendingDelete.promise
    }
  })
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: () => {}, removeListener: () => {} },
    },
    storage: { onChanged: { addListener: () => {}, removeListener: () => {} } },
  })
})

const roots: Root[] = []

afterEach(() => {
  // Unmount while `document` still exists, or a reload timer scheduled by a
  // settled delete fires into a torn-down jsdom.
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount()
    })
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function renderHistory(): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(
      createElement(
        I18nProvider,
        { value: { locale: 'en' as const, t } },
        createElement(HistoryTab),
      ),
    )
  })
  await flush()
  return container
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const byText = (container: HTMLElement, selector: string, text: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll(selector)].find(
    (button) => button.textContent?.trim() === text,
  )
  if (!found) throw new Error(`no button labelled "${text}"`)
  return found as HTMLButtonElement
}

/** The batch toolbar of the visible section. */
const batchBar = (container: HTMLElement): ParentNode =>
  container.querySelector('.record-batchbar') ?? container

const batchDelete = (container: HTMLElement): HTMLButtonElement =>
  byText(container, '.record-batchbar-actions button', t.histBatchDelete)

const batchSelectAll = (container: HTMLElement): HTMLInputElement =>
  batchBar(container).querySelector<HTMLInputElement>('.record-batchbar-check input')!

const sectionTab = (container: HTMLElement, label: string): HTMLButtonElement =>
  byText(container, '.history-sections .tab', label)

/** Let the in-flight command settle. The mocked lists keep their records so the
 *  toolbar stays mounted and its buttons can be re-checked. */
async function settleDelete(): Promise<void> {
  act(() => pendingDelete.settle())
  await flush()
}

describe('history deletion loading state', () => {
  it('labels the batch delete as in flight and re-enables it once it settles', async () => {
    const container = await renderHistory()
    const button = batchDelete(container)
    expect(button.textContent).toBe(t.histBatchDelete)

    click(batchSelectAll(container))
    click(button)

    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe(t.histDeleting)
    // Every other destructive control of the section is latched too.
    expect(container.querySelector<HTMLButtonElement>('.record-delete')!.disabled).toBe(true)

    await settleDelete()

    // The latch is released; the batch button itself goes back to being
    // disabled only because the selection was cleared by the delete.
    expect(button.textContent).toBe(t.histBatchDelete)
    expect(container.querySelector<HTMLButtonElement>('.record-delete')!.disabled).toBe(false)
  })

  it('counts records with the localized label, not a hardcoded string', async () => {
    const container = await renderHistory()
    expect(batchBar(container).textContent).toContain(t.histRecordCount({ count: 2 }))
  })

  it('ignores a second click while the first delete is still running', async () => {
    const container = await renderHistory()
    click(batchSelectAll(container))
    const button = batchDelete(container)

    click(button)
    // The handler awaits the confirm dialog before it deletes anything.
    await flush()
    click(button)
    click(button)

    // The batch handler deletes one row at a time, so the latch sees exactly one
    // command in flight no matter how often the button was clicked.
    expect(deleteCalls).toBe(1)
    await settleDelete()
    // …and the queue then finishes the second selected row without restarting.
    expect(deleteCalls).toBe(2)
  })

  it('latches the whole section when a single row is deleted', async () => {
    const container = await renderHistory()
    const row = container.querySelector<HTMLButtonElement>('.record-delete')!
    const button = batchDelete(container)

    click(row)

    expect(row.disabled).toBe(true)
    expect(deleteCalls).toBe(1)
    expect(button.textContent).toBe(t.histDeleting)

    await settleDelete()
    expect(row.disabled).toBe(false)
  })

  it('latches the run log clear control while it runs', async () => {
    const container = await renderHistory()
    click(sectionTab(container, t.histTaskRuns))
    await flush()

    const clear = byText(container, '.record-batchbar-actions button', t.taskRunsClear)
    click(clear)
    await flush()

    expect(clear.disabled).toBe(true)
    expect(deleteCalls).toBe(1)

    await settleDelete()
    expect(clear.disabled).toBe(false)
    expect(deleteCalls).toBe(1)
  })

  it('latches the operations clear control while it runs', async () => {
    const container = await renderHistory()
    click(sectionTab(container, t.histOperations))
    await flush()

    const clear = byText(container, '.record-batchbar-actions button', t.dataClearHistory)
    click(clear)
    await flush()

    expect(clear.disabled).toBe(true)
    expect(deleteCalls).toBe(1)

    await settleDelete()
    expect(clear.disabled).toBe(false)
  })
})
