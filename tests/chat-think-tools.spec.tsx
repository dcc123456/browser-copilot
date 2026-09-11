// @vitest-environment jsdom
/**
 * Component tests for assistant-turn rendering in the chat log:
 *
 * 1. `<think>…</think>` reasoning is rendered as its own collapsible block,
 *    never as literal tags mixed into the answer;
 * 2. tool calls that happen mid-turn render as compact cards INSIDE one
 *    assistant bubble, instead of as loose chips between split bubbles;
 * 3. text streamed after a tool round stays in the SAME bubble, so one reply
 *    no longer breaks into two disconnected paragraphs;
 * 4. the restored transcript (`restore` message) renders the same structure.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sendCommand: vi.fn(),
}))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})

import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Command } from '../src/lib/messages'
import ChatTab from '../src/sidepanel/ChatTab'

const portMessageListeners: ((message: unknown) => void)[] = []
const fakePort = {
  postMessage: vi.fn(),
  // A real Port drops its listeners when disconnected; the chat effect
  // reconnects (resume tick), so stale listeners would otherwise double-apply
  // every streamed message.
  disconnect: vi.fn(() => {
    portMessageListeners.length = 0
  }),
  onMessage: {
    addListener: (fn: (message: unknown) => void) => portMessageListeners.push(fn),
    removeListener: (fn: (message: unknown) => void) => {
      const index = portMessageListeners.indexOf(fn)
      if (index >= 0) portMessageListeners.splice(index, 1)
    },
  },
  onDisconnect: { addListener: () => {}, removeListener: () => {} },
}

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

beforeEach(() => {
  portMessageListeners.length = 0
  mocks.sendCommand.mockReset()
  mocks.sendCommand.mockImplementation(async (command: Command) => {
    switch (command.type) {
      case 'conversations.list':
        return { type: 'conversations.list', conversations: [] }
      case 'settings.get':
        return { type: 'settings', settings: { mode: 'semi' } }
      case 'history.list':
        return { type: 'history.list', entries: [] }
      default:
        return { type: command.type }
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

async function renderChat(): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(ChatTab, { skills: [], activeSkillId: null, onSelectSkill: () => {} }),
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { container, root }
}

async function push(message: unknown): Promise<void> {
  await act(async () => {
    for (const listener of portMessageListeners) listener(message)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('assistant turn · reasoning, tools and split replies', () => {
  it('keeps think blocks, tool calls and all text segments in one ordered bubble', async () => {
    const { container, root } = await renderChat()
    try {
      // Tokens arrive mid-thought first: the reasoning block is open before
      // the closing tag streams in.
      await push({ type: 'delta', text: '<think>reasoning here' })
      const thinkWhileStreaming = container.querySelector('[data-kind="think"]') as HTMLElement
      expect(thinkWhileStreaming).toBeTruthy()
      expect(thinkWhileStreaming.textContent).toContain('reasoning here')
      expect(thinkWhileStreaming.hasAttribute('open')).toBe(true)

      // The closing tag and the first half of the answer stream in.
      await push({ type: 'delta', text: '</think>first half ' })

      await push({ type: 'tool.start', name: 'click' })
      const runningCard = container.querySelector(
        '[data-kind="tool"][data-state="running"]',
      ) as HTMLElement
      expect(runningCard.textContent).toContain('click')

      await push({ type: 'tool.result', name: 'click', summary: 'clicked #go' })
      await push({ type: 'delta', text: 'second half' })
      await push({ type: 'done' })

      // One single assistant turn bubble for the whole stream.
      const turns = container.querySelectorAll('[data-role="assistant-turn"]')
      expect(turns).toHaveLength(1)
      const turn = turns[0] as HTMLElement

      // Raw think tags never reach the DOM.
      expect(turn.innerHTML).not.toContain('&lt;think&gt;')
      expect(turn.textContent).not.toContain('<think>')
      // The old loose-chip UI is gone.
      expect(container.querySelectorAll('.tool-chip')).toHaveLength(0)

      // The completed tool card shows name + summary and is expandable.
      const toolCard = container.querySelector(
        '[data-kind="tool"][data-state="done"]',
      ) as HTMLElement
      expect(toolCard.textContent).toContain('click')
      expect(toolCard.textContent).toContain('clicked #go')

      // Chronological order inside the one bubble:
      // reasoning → first text half → tool call → second text half.
      const text = turn.textContent ?? ''
      const iReason = text.indexOf('reasoning here')
      const iFirst = text.indexOf('first half')
      const iTool = text.indexOf('clicked #go')
      const iSecond = text.indexOf('second half')
      expect(iReason).toBeGreaterThanOrEqual(0)
      expect(iFirst).toBeGreaterThan(iReason)
      expect(iTool).toBeGreaterThan(iFirst)
      expect(iSecond).toBeGreaterThan(iTool)

      // The reasoning block auto-collapses when the turn finishes.
      const thinkAfter = container.querySelector('[data-kind="think"]') as HTMLDetailsElement
      expect(thinkAfter.open).toBe(false)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('renders a restored transcript with the same grouped structure', async () => {
    const { container, root } = await renderChat()
    try {
      await push({
        type: 'restore',
        running: false,
        messages: [
          { role: 'user', text: 'do the thing' },
          { role: 'assistant', text: '<think>r</think>hi' },
          { role: 'tool', text: '← click: clicked #go' },
          { role: 'assistant', text: 'more after the tool' },
        ],
      })

      const turns = container.querySelectorAll('[data-role="assistant-turn"]')
      expect(turns).toHaveLength(1)
      const turn = turns[0] as HTMLElement
      expect(turn.textContent).toContain('hi')
      expect(turn.textContent).toContain('more after the tool')
      expect(turn.textContent).not.toContain('<think>')

      const think = turn.querySelector('[data-kind="think"]')
      expect(think?.textContent).toContain('r')

      const toolCard = turn.querySelector('[data-kind="tool"]') as HTMLElement
      expect(toolCard.dataset.state).toBe('done')
      expect(toolCard.textContent).toContain('click')
      expect(toolCard.textContent).toContain('clicked #go')
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })
})
