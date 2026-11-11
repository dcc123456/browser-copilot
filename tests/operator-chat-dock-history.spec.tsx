// @vitest-environment jsdom
/**
 * Editor AI assistant: saved chats are bound to the workflow id.
 *
 * What is pinned here is the dock side of the persistence contract — restoring
 * the newest chat on open, saving a snapshot per turn, switching and deleting
 * chats, and staying completely inert when the workflow has no id yet. The
 * storage side has its own spec (`operator-chat-sessions.spec.ts`).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn() }))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})

vi.mock('../src/workflow-editor/blocks/shared/element-pick', () => ({
  describePickFailure: () => null,
  requestElementPick: vi.fn(async () => ({ ok: false, failure: 'cancelled' })),
}))

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  for (const method of ['scrollTo', 'scrollBy'] as const) {
    Object.defineProperty(Element.prototype, method, { value: () => {}, configurable: true })
  }
})

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import OperatorChatDock from '../src/workflow-editor/ai/OperatorChatDock'
import type { Command, CommandResult } from '../src/lib/messages'
import type { OperatorChatSession } from '../src/lib/workflow/operator-chat-sessions'

/** Key passthrough, so labels in the DOM are the i18n key names. */
const t = (key: string) => key

const context = { graphDigest: '1. trigger', workflowId: 'wf-1' }

const adviseReply: Extract<CommandResult, { type: 'workflows.operatorAdvise' }> = {
  type: 'workflows.operatorAdvise',
  data: { ok: true, reply: 'Added one step', action: 'append', proposals: [], rejected: [] },
}

const landing = {
  kind: 'chain' as const,
  added: 0,
  applied: false,
  skipped: [],
  pruned: [],
  missing: [],
}

function chat(id: string, title: string, content: string, updatedAt: number): OperatorChatSession {
  return {
    id,
    workflowId: 'wf-1',
    title,
    createdAt: 1_000,
    updatedAt,
    turns: [
      { role: 'user', content },
      { role: 'assistant', content: `Answer to ${content}` },
    ],
  }
}

let saved: OperatorChatSession[] = []
let seen: Command[] = []
let container: HTMLElement
const roots: Root[] = []

beforeEach(() => {
  saved = []
  seen = []
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: { addListener: () => {}, removeListener: () => {} },
    },
  })
  mocks.sendCommand.mockReset()
  mocks.sendCommand.mockImplementation(async (command: Command): Promise<CommandResult> => {
    seen.push(command)
    switch (command.type) {
      case 'operatorChat.sessions':
        return { type: 'operatorChat.sessions', sessions: saved }
      case 'operatorChat.sessions.save':
        saved = [command.session, ...saved.filter((entry) => entry.id !== command.session.id)]
        return { type: 'operatorChat.sessions.save', ok: true }
      case 'operatorChat.sessions.delete':
        saved = saved.filter((entry) => entry.id !== command.sessionId)
        return { type: 'operatorChat.sessions.delete', ok: true }
      case 'workflows.operatorAdvise':
        return adviseReply
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

const render = async (workflowId: string | null): Promise<void> => {
  container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      createElement(OperatorChatDock, {
        t,
        workflowId,
        getContext: () => context,
        onApply: () => landing,
        onUndo: () => {},
      }),
    )
  })
  await flush()
}

const openDock = async (): Promise<void> => {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="operatorAiTitle"]')?.click()
  })
  await flush()
}

const textButton = (text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined

const labelledButton = (label: string): HTMLButtonElement | undefined =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? undefined

/** Session rows carry a title and a date, so match the title's own span. */
const sessionButton = (title: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    [...button.querySelectorAll('span')].some((span) => span.textContent === title),
  )

const typeInto = async (value: string): Promise<void> => {
  const field = container.querySelector('textarea') as HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const commandsOf = (type: Command['type']): Command[] =>
  seen.filter((command) => command.type === type)

describe('operator chat history in the dock', () => {
  it('restores the newest saved chat without writing it straight back', async () => {
    saved = [
      chat('chat-2', 'Second', 'second question', 2_000),
      chat('chat-1', 'First', 'first question', 1_000),
    ]
    await render('wf-1')
    await openDock()

    expect(container.textContent).toContain('second question')
    expect(container.textContent).not.toContain('first question')
    expect(commandsOf('operatorChat.sessions')).toHaveLength(1)
    expect(commandsOf('operatorChat.sessions.save')).toHaveLength(0)
  })

  it('saves the transcript of the first message under the workflow id', async () => {
    await render('wf-1')
    await openDock()
    await typeInto('add a click step')
    await act(async () => {
      textButton('operatorAiSend')?.click()
    })
    await flush()

    const saves = commandsOf('operatorChat.sessions.save') as Extract<
      Command,
      { type: 'operatorChat.sessions.save' }
    >[]
    expect(saves.length).toBeGreaterThan(0)
    expect(saves[0]!.workflowId).toBe('wf-1')
    expect(saves[0]!.session.workflowId).toBe('wf-1')
    expect(saves[0]!.session.title).toBe('add a click step')
    expect(saves[0]!.session.turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'add a click step' }),
      ]),
    )
    // Every snapshot of one conversation must share a single session id.
    expect(new Set(saves.map((command) => command.session.id)).size).toBe(1)
  })

  it('switches to another saved chat without persisting the switch itself', async () => {
    saved = [
      chat('chat-2', 'Second', 'second question', 2_000),
      chat('chat-1', 'First', 'first question', 1_000),
    ]
    await render('wf-1')
    await openDock()
    const savesBefore = commandsOf('operatorChat.sessions.save').length

    await act(async () => {
      labelledButton('operatorAiHistory')?.click()
    })
    await flush()
    await act(async () => {
      sessionButton('First')?.click()
    })
    await flush()

    expect(container.textContent).toContain('first question')
    expect(container.textContent).not.toContain('second question')
    expect(commandsOf('operatorChat.sessions.save')).toHaveLength(savesBefore)
  })

  it('deletes one saved chat after confirmation', async () => {
    saved = [
      chat('chat-2', 'Second', 'second question', 2_000),
      chat('chat-1', 'First', 'first question', 1_000),
    ]
    vi.stubGlobal('confirm', () => true)
    await render('wf-1')
    await openDock()
    await act(async () => {
      labelledButton('operatorAiHistory')?.click()
    })
    await flush()

    const deleteButtons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (button) => button.getAttribute('aria-label') === 'operatorAiSessionDelete',
    )
    expect(deleteButtons).toHaveLength(2)
    await act(async () => {
      deleteButtons[0]?.click()
    })
    await flush()

    const deletions = commandsOf('operatorChat.sessions.delete') as Extract<
      Command,
      { type: 'operatorChat.sessions.delete' }
    >[]
    expect(deletions).toHaveLength(1)
    expect(deletions[0]!.sessionId).toBe('chat-2')
    expect(deletions[0]!.workflowId).toBe('wf-1')
  })

  it('does no persistence at all for a workflow that has no id', async () => {
    await render(null)
    await openDock()
    await typeInto('hello')
    await act(async () => {
      textButton('operatorAiSend')?.click()
    })
    await flush()

    expect(seen.filter((command) => command.type.startsWith('operatorChat.'))).toHaveLength(0)
    expect(labelledButton('operatorAiHistory')?.disabled).toBe(true)
  })
})
