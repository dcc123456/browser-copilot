// @vitest-environment jsdom
/**
 * Component test for the Duplicate action on a workflow card
 * (`sidepanel/WorkflowsTab`), driving the REAL component with a mocked command
 * channel. Pins the two things that make the button trustworthy:
 *
 * 1. a click asks the worker for a copy and reports the copy's own name — the
 *    panel never names it, so the banner cannot claim a name the stored record
 *    does not have;
 * 2. the worker resolving with NO workflow (the source was deleted elsewhere) is
 *    a failure, not a quiet success.
 *
 * The copy itself (fresh id, no inherited revision line) is covered by
 * `workflow-storage.spec.ts`.
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
import type { Command, CommandResult } from '../src/lib/messages'
import type { Workflow } from '../src/lib/workflow/types'
import { messagesFor } from '../src/lib/i18n'
import { I18nProvider } from '../src/sidepanel/i18n'
import WorkflowsTab from '../src/sidepanel/WorkflowsTab'

type DuplicateCommand = Extract<Command, { type: 'workflows.duplicate' }>
type DuplicateReply = Extract<CommandResult, { type: 'workflows.duplicate' }>

const DUPLICATE = messagesFor('en').workflowsDuplicate

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

let workflows: Workflow[] = []
/** What `workflows.duplicate` answers; reset per test. */
let duplicateReply: DuplicateReply = {
  type: 'workflows.duplicate',
  workflow: workflow('copy-1', 'Scrape leads (copy)'),
}
const seen: Command[] = []

beforeEach(() => {
  workflows = [workflow('wf-1', 'Scrape leads')]
  duplicateReply = {
    type: 'workflows.duplicate',
    workflow: workflow('copy-1', 'Scrape leads (copy)'),
  }
  seen.length = 0
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
      case 'record.status':
        return { type: 'record.status', recording: false }
      case 'workflows.duplicate':
        return duplicateReply
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

const buttonByText = (container: HTMLElement, text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined

const duplicates = (): DuplicateCommand[] =>
  seen.filter((command): command is DuplicateCommand => command.type === 'workflows.duplicate')

const bannerText = (container: HTMLElement): string =>
  container.querySelector('.banner-text')?.textContent ?? ''

describe('workflow card Duplicate action', () => {
  it('asks the worker to duplicate the clicked workflow', async () => {
    const { container, root } = await render()
    const button = buttonByText(container, DUPLICATE)
    expect(button).toBeDefined()

    await act(async () => {
      button!.click()
    })
    await flush()

    expect(duplicates()).toEqual([{ type: 'workflows.duplicate', id: 'wf-1' }])
    await act(async () => root.unmount())
  })

  it('reports the name the worker gave the copy', async () => {
    duplicateReply = {
      type: 'workflows.duplicate',
      workflow: workflow('copy-1', 'Scrape leads (copy)'),
    }
    const { container, root } = await render()

    await act(async () => {
      buttonByText(container, DUPLICATE)!.click()
    })
    await flush()

    expect(bannerText(container)).toBe(
      messagesFor('en').workflowsDuplicated({ name: 'Scrape leads (copy)' }),
    )
    // The list is re-read so the new card shows up without reopening the panel.
    const lists = seen.filter((command) => command.type === 'workflows.list')
    expect(lists.length).toBeGreaterThan(1)
    await act(async () => root.unmount())
  })

  it('treats an empty reply as a failure instead of a silent success', async () => {
    // The source was deleted elsewhere: the worker resolves with no copy.
    duplicateReply = { type: 'workflows.duplicate', workflow: undefined }
    const { container, root } = await render()

    await act(async () => {
      buttonByText(container, DUPLICATE)!.click()
    })
    await flush()

    expect(bannerText(container)).toBe(messagesFor('en').workflowsDuplicateFailed)
    await act(async () => root.unmount())
  })
})
