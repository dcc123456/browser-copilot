// @vitest-environment jsdom
/**
 * Component test for the chat composer's "compress context" action, driving the
 * REAL ChatTab with a mocked command channel and port. Pins the contract:
 *
 * 1. the action is a Command — the panel never rewrites a stored transcript
 *    itself (see `tests/panel-no-direct-writes.spec.ts`);
 * 2. a compression that landed re-pulls the transcript over the port, so the
 *    view shows what the worker actually stored;
 * 3. a refused compression leaves the conversation alone and only reports why.
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

const compactButton = (scope: ParentNode): HTMLButtonElement | null =>
  scope.querySelector('button[aria-label="Compress context"]')

describe('manual context compression', () => {
  it('sends the compression as a command and re-pulls the transcript', async () => {
    const mounted = await mountWithConversation()
    const button = compactButton(mounted)
    expect(button).not.toBeNull()
    await act(async () => {
      button?.click()
    })
    await flush()
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
    const mounted = await mountWithConversation()
    await act(async () => {
      compactButton(mounted)?.click()
    })
    await flush()
    expect(fakePort.postMessage).not.toHaveBeenCalledWith({
      type: 'resume',
      conversationId: 'default',
    })
    expect(mocks.toast).toHaveBeenCalledTimes(1)
  })

  it('is not usable while a reply is still streaming', async () => {
    const mounted = await mountWithConversation(true)
    expect(compactButton(mounted)?.disabled ?? false).toBe(true)
  })
})
