// @vitest-environment jsdom
/**
 * A conversation whose turn was cut off by a crash must open normally and say
 * so. The worker flags `restore.interrupted` when the stored turn state claims a
 * running turn that no live channel owns; the panel then shows the recovered
 * transcript plus one status line explaining why it stops.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn() }))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
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
import ChatTab from '../src/sidepanel/ChatTab'
import { messagesFor } from '../src/lib/i18n'

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

// The panel resolves its dictionary from the browser language; accept either
// translation so the test does not depend on the host locale.
const INTERRUPTED_TEXTS = [
  messagesFor('en').chatTurnInterrupted,
  messagesFor('zh-CN').chatTurnInterrupted,
]

beforeEach(() => {
  portMessageListeners.length = 0
  fakePort.postMessage.mockReset()
  mocks.sendCommand.mockReset()
  mocks.sendCommand.mockImplementation(async (command: { type: string }) => {
    switch (command.type) {
      case 'history.list':
        return { type: 'history.list', entries: [] }
      case 'conversations.list':
        return { type: 'conversations.list', conversations: [] }
      case 'settings.get':
        return { type: 'settings', settings: { mode: 'chat' } }
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

async function mountAndRestore(interrupted: boolean): Promise<HTMLDivElement> {
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
          { role: 'user', text: 'long task please' },
          { role: 'assistant', text: 'step one is done' },
        ],
        running: false,
        ...(interrupted ? { interrupted: true } : {}),
      })
    }
  })
  await flush()
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('interrupted conversation replay', () => {
  it('shows the saved transcript and explains the interruption', async () => {
    const view = await mountAndRestore(true)
    expect(view.textContent).toContain('long task please')
    expect(view.textContent).toContain('step one is done')
    expect(INTERRUPTED_TEXTS.some((text) => view.textContent?.includes(text))).toBe(true)
  })

  it('adds no notice for a turn that ended normally', async () => {
    const view = await mountAndRestore(false)
    expect(view.textContent).toContain('step one is done')
    expect(INTERRUPTED_TEXTS.some((text) => view.textContent?.includes(text))).toBe(false)
  })
})
