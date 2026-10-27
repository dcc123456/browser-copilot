// @vitest-environment jsdom
/**
 * Component test for `/compact`, the slash command that replaced the composer's
 * "compress context" button. Drives the REAL ChatTab with a mocked command
 * channel and port. Pins the contract:
 *
 * 1. the command is offered by the `/` menu only while it can actually run;
 * 2. running it is a Command — the panel never rewrites a stored transcript
 *    itself (see `tests/panel-no-direct-writes.spec.ts`);
 * 3. a compression that landed re-pulls the transcript over the port, so the
 *    view shows what the worker actually stored;
 * 4. a refused compression leaves the conversation alone and only reports why;
 * 5. the old toolbar button is gone.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sendCommand: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})
vi.mock('../src/ui/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/toast')>()
  return { ...actual, toast: mocks.toast }
})

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom implements neither scrolling API; the transcript log auto-scrolls.
  for (const method of ['scrollTo', 'scrollBy'] as const) {
    Object.defineProperty(Element.prototype, method, { value: () => {}, configurable: true })
  }
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: () => {},
    configurable: true,
  })
})

import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Command, CommandResult } from '../src/lib/messages'
import ChatTab from '../src/sidepanel/ChatTab'

const portMessageListeners: ((message: unknown) => void)[] = []
const fakePort = {
  postMessage: vi.fn(),
  disconnect: vi.fn(),
  onMessage: {
    addListener: (fn: (message: unknown) => void) => portMessageListeners.push(fn),
    removeListener: (fn: (message: unknown) => void) => {
      const index = portMessageListeners.indexOf(fn)
      if (index >= 0) portMessageListeners.splice(index, 1)
    },
  },
  onDisconnect: { addListener: () => {}, removeListener: () => {} },
}

type CompactResult = Extract<CommandResult, { type: 'conversations.compact' }>

/** What the next `conversations.compact` answers; tests override it. */
let compactReply: CompactResult

beforeEach(() => {
  portMessageListeners.length = 0
  fakePort.postMessage.mockReset()
  mocks.toast.mockReset()
  mocks.sendCommand.mockReset()
  compactReply = { type: 'conversations.compact', outcome: 'compacted', removed: 3 }
  mocks.sendCommand.mockImplementation(async (command: Command) => {
    switch (command.type) {
      case 'history.list':
        return { type: 'history.list', entries: [] }
      case 'conversations.list':
        return { type: 'conversations.list', conversations: [] }
      case 'settings.get':
        return { type: 'settings', settings: { mode: 'chat' } }
      case 'conversations.compact':
        return compactReply
      default:
        throw new Error(`unexpected command: ${command.type}`)
    }
  })
  vi.stubGlobal('chrome', {
    runtime: {
      connect: vi.fn(() => fakePort),
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: () => {}, removeListener: () => {} },
    },
    windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

let container: HTMLDivElement | null = null
let root: Root | null = null

/**
 * Mount ChatTab and hand it a stored four-message conversation through the
 * port's `restore`. `running: true` is the mid-turn case: the panel is busy.
 */
async function mountWithConversation(running = false): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      createElement(ChatTab, { skills: [], activeSkillId: null, onSelectSkill: () => {} }),
    )
  })
  await flush()
  await act(async () => {
    for (const listener of portMessageListeners) {
      listener({
        type: 'restore',
        messages: [
          { role: 'user', text: 'first question' },
          { role: 'assistant', text: 'answer one' },
          { role: 'user', text: 'second question' },
          { role: 'assistant', text: 'answer two' },
        ],
        running,
      })
    }
  })
  await flush()
  // Mounting already resumes the stored conversation; only a second resume can
  // come from the compression itself.
  fakePort.postMessage.mockClear()
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

/** Types `text` into the composer the way a keyboard would (caret at the end). */
async function typeInto(text: string): Promise<HTMLTextAreaElement> {
  const field = container?.querySelector('textarea') as HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field, text)
    field.setSelectionRange(text.length, text.length)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
  return field
}

const slashItems = (scope: ParentNode): HTMLButtonElement[] => [
  ...scope.querySelectorAll<HTMLButtonElement>('.slash-item'),
]

/** Opens the `/` menu on `term` and confirms Enter on the highlighted entry. */
async function runCompactCommand(): Promise<void> {
  await typeInto('/compact')
  const field = container?.querySelector('textarea') as HTMLTextAreaElement
  expect(slashItems(container!).map((item) => item.textContent)).toEqual([
    expect.stringContaining('/compact'),
  ])
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await flush()
  await flush()
}

describe('/compact command', () => {
  it('replaces the old toolbar button', async () => {
    const mounted = await mountWithConversation()
    expect(mounted.querySelector('button[aria-label="Compress context"]')).toBeNull()
  })

  it('sends the compression as a command and re-pulls the transcript', async () => {
    await mountWithConversation()
    await runCompactCommand()
    expect(mocks.sendCommand).toHaveBeenCalledWith({
      type: 'conversations.compact',
      conversationId: 'default',
    })
    expect(fakePort.postMessage).toHaveBeenCalledWith({ type: 'resume', conversationId: 'default' })
    // The count the worker reported reaches the user.
    expect(mocks.toast.mock.calls.some(([text]) => String(text).includes('3'))).toBe(true)
  })

  it('leaves the conversation alone when there is nothing to compress', async () => {
    compactReply = { type: 'conversations.compact', outcome: 'nothing', removed: 0 }
    await mountWithConversation()
    await runCompactCommand()
    expect(fakePort.postMessage).not.toHaveBeenCalledWith({
      type: 'resume',
      conversationId: 'default',
    })
    expect(mocks.toast).toHaveBeenCalledTimes(1)
  })

  it('is not offered while a reply is still streaming', async () => {
    await mountWithConversation(true)
    const field = await typeInto('/compact')
    expect(slashItems(container!)).toEqual([])
    // The typed text stays ordinary text; nothing was executed.
    expect(field.value).toBe('/compact')
    expect(mocks.sendCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'conversations.compact' }),
    )
  })
})
