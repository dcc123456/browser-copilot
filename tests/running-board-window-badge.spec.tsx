// @vitest-environment jsdom
/**
 * Component tests for the activity board's run-window badge
 * (`sidepanel/RunningBoard`).
 *
 * Parallel runs are invisible unless the panel shows them, so the board owes the
 * user three things: a row that says WHICH window the run works in, the word
 * "dedicated" when the extension opened that window itself (as opposed to the
 * shared plugin window), and a click that brings the window forward — with an
 * honest error when the window is already gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn(), toast: vi.fn() }))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})
vi.mock('../src/ui/toast', () => ({ toast: mocks.toast }))

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Command, FinishedTaskView, RunningTaskView } from '../src/lib/messages'
import { messagesFor } from '../src/lib/i18n'
import { I18nProvider } from '../src/sidepanel/i18n'
import RunningBoard from '../src/sidepanel/RunningBoard'

const t = messagesFor('en')

let running: RunningTaskView[] = []
let finished: FinishedTaskView[] = []
const seen: Command[] = []

function run(overrides: Partial<RunningTaskView>): RunningTaskView {
  return {
    runId: 'run-1',
    label: 'Morning digest',
    source: 'schedule',
    startedAt: 1,
    steps: [{ kind: 'status', text: 'starting', at: 1 }],
    ...overrides,
  }
}

const buttons = (root: ParentNode): HTMLButtonElement[] => [...root.querySelectorAll('button')]

const badge = (root: ParentNode, label: string): HTMLButtonElement | undefined =>
  buttons(root).find((candidate) => candidate.textContent?.trim() === label)

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  running = []
  finished = []
  seen.length = 0
  mocks.sendCommand.mockReset()
  mocks.toast.mockReset()
  mocks.sendCommand.mockImplementation(async (command: Command): Promise<unknown> => {
    seen.push(command)
    if (command.type === 'tasks.running') {
      return { type: 'tasks.running', runs: running, finished }
    }
    if (command.type === 'tasks.focusWindow') {
      return { type: 'tasks.focusWindow', ok: true }
    }
    throw new Error(`unexpected command: ${command.type}`)
  })
})

afterEach(() => {
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
        createElement(RunningBoard),
      ),
    )
  })
  await flush()
  return container
}

describe('running board window badge', () => {
  it('shows no badge for a run that never resolved a window', async () => {
    running = [run({})]
    const container = await render()
    expect(container.textContent).toContain('Morning digest')
    expect(badge(container, t.taskRunWindow({ id: 500 }))).toBeUndefined()
    expect(badge(container, t.taskRunWindowDedicated)).toBeUndefined()
  })

  it('names the shared window and focuses it on click', async () => {
    running = [run({ windowId: 500, runWindowKind: 'shared' })]
    const container = await render()
    const tag = badge(container, t.taskRunWindow({ id: 500 }))
    expect(tag).toBeTruthy()
    // Every badge states what the click does.
    expect(tag?.title).toBe(t.taskRunWindowFocus)

    await act(async () => {
      tag?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(seen).toContainEqual({ type: 'tasks.focusWindow', runId: 'run-1' })
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('says dedicated when the run opened its own window', async () => {
    running = [run({ windowId: 501, runWindowKind: 'dedicated' })]
    const container = await render()
    expect(badge(container, t.taskRunWindowDedicated)).toBeTruthy()
    expect(badge(container, t.taskRunWindow({ id: 501 }))).toBeUndefined()
  })

  it('reports a window that closed before the click landed', async () => {
    running = [run({ windowId: 502, runWindowKind: 'dedicated' })]
    mocks.sendCommand.mockImplementation(async (command: Command): Promise<unknown> => {
      if (command.type === 'tasks.running') {
        return { type: 'tasks.running', runs: running, finished }
      }
      return { type: 'tasks.focusWindow', ok: false, closed: true }
    })
    const container = await render()
    const tag = badge(container, t.taskRunWindowDedicated)
    await act(async () => {
      tag?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(mocks.toast).toHaveBeenCalledWith(t.taskRunWindowGone, 'error')
  })
})
