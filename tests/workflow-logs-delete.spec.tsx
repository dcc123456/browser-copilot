// @vitest-environment jsdom
/**
 * Editor run-log deletion: one log or a whole selection, behind a confirmation,
 * and never a running run (finishRun would write it straight back to the
 * finished board). Also pins that the post-delete reload cannot resurrect a row
 * that an older in-flight poll still had in its response.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn() }))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})

// The real Modal portals to <body> and needs the editor locale context; a flat
// host keeps every assertion on the log list itself.
vi.mock('../src/workflow-editor/ui/Modal', () => ({
  default: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? createElement('div', null, children) : null,
}))
vi.mock('../src/workflow-editor/sidebar/RunDetailModal', () => ({ default: () => null }))

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

import LogsModal from '../src/workflow-editor/sidebar/LogsModal'
import type { RunView } from '../src/workflow-editor/sidebar/log-view'
import type { Command, CommandResult } from '../src/lib/messages'

/** Key passthrough, so labels in the DOM are the i18n key names. */
const t = (key: string) => key

function run(runId: string, outcome?: RunView['outcome']): RunView {
  return {
    runId,
    label: runId,
    source: 'editor',
    startedAt: 1_000,
    ...(outcome ? { outcome, finishedAt: 2_000 } : {}),
    steps: [],
  }
}

let running: RunView[] = []
let finished: RunView[] = []
let seen: Command[] = []
let confirmMock: ReturnType<typeof vi.fn>
let container: HTMLElement
const roots: Root[] = []

beforeEach(() => {
  running = []
  finished = []
  seen = []
  confirmMock = vi.fn(() => true)
  vi.stubGlobal('confirm', confirmMock)
  mocks.sendCommand.mockReset()
  mocks.sendCommand.mockImplementation(async (command: Command): Promise<CommandResult> => {
    seen.push(command)
    switch (command.type) {
      case 'workflows.running':
        return {
          type: 'workflows.running',
          runs: running,
          finished,
        } as unknown as CommandResult
      case 'tasks.finished.delete':
        finished = finished.filter((entry) => entry.runId !== command.runId)
        return { type: 'tasks.finished.delete' } as unknown as CommandResult
      default:
        return { type: command.type } as unknown as CommandResult
    }
  })
})

afterEach(() => {
  while (roots.length > 0) {
    const mounted = roots.pop()!
    act(() => mounted.unmount())
  }
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const render = async (): Promise<void> => {
  container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      createElement(LogsModal, {
        open: true,
        onClose: () => {},
        workflowId: 'wf-1',
        debugMode: false,
        t,
      }),
    )
  })
  await flush()
}

const click = async (element: Element | null | undefined): Promise<void> => {
  expect(element).toBeTruthy()
  await act(async () => {
    ;(element as HTMLElement).click()
  })
  await flush()
}

const deletes = (): Command[] => seen.filter((command) => command.type === 'tasks.finished.delete')

describe('deleting editor run logs', () => {
  it('deletes one finished log after confirmation and reloads the board', async () => {
    finished = [run('run-a', 'ok'), run('run-b', 'failed')]
    await render()

    await click(container.querySelector('button[aria-label="logsDeleteOne"]'))

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(deletes()).toEqual([{ type: 'tasks.finished.delete', runId: 'run-a' }])
    expect(container.textContent).not.toContain('run-a')
    expect(container.textContent).toContain('run-b')
  })

  it('does nothing when the confirmation is declined', async () => {
    confirmMock.mockReturnValue(false)
    finished = [run('run-a', 'ok')]
    await render()

    await click(container.querySelector('button[aria-label="logsDeleteOne"]'))

    expect(deletes()).toHaveLength(0)
    expect(container.textContent).toContain('run-a')
  })

  it('deletes every selected finished log in bulk', async () => {
    finished = [run('run-a', 'ok'), run('run-b', 'ok'), run('run-c', 'cancelled')]
    await render()

    await click(container.querySelector('.wf-logs-selectall input'))
    await click(container.querySelector('.wf-logs-delete-selected'))

    expect(deletes().map((command) => (command as { runId: string }).runId)).toEqual([
      'run-a',
      'run-b',
      'run-c',
    ])
    expect(container.querySelectorAll('.wf-logs-batchbar')).toHaveLength(0)
  })

  it('never lets a running row be selected or deleted', async () => {
    running = [run('live-run')]
    finished = [run('run-a', 'ok')]
    await render()

    const rows = container.querySelectorAll('.wf-run-row')
    expect(rows).toHaveLength(2)
    const liveRow = rows[0]!
    expect(liveRow.querySelector<HTMLInputElement>('.wf-run-check')?.disabled).toBe(true)
    expect(liveRow.querySelector<HTMLButtonElement>('.wf-run-delete')?.disabled).toBe(true)

    await click(container.querySelector('.wf-logs-selectall input'))
    await click(container.querySelector('.wf-logs-delete-selected'))

    expect(deletes()).toEqual([{ type: 'tasks.finished.delete', runId: 'run-a' }])
  })
})
