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
 * 4. the restored transcript (`restore` message) renders the same structure;
 * 5. a panel reopened while a turn is still running keeps updating: the
 *    snapshot first, then the lines buffered while it was closed, then the live
 *    stream — and a re-sent approval card does not stack.
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

describe('panel reopened while a turn is still running', () => {
  it('keeps showing live progress after the restored snapshot', async () => {
    const { container, root } = await renderChat()
    try {
      // What a reopened panel gets first: the transcript as the worker has it,
      // plus the notice that the turn carried on without it.
      await push({
        type: 'restore',
        running: true,
        messages: [
          { role: 'user', text: 'read the top stories' },
          { role: 'assistant', text: 'I will open the page.' },
          { role: 'tool', text: '← open_url: opened news' },
        ],
      })
      const buttonLabels = [...container.querySelectorAll('button')].map((button) =>
        button.textContent?.trim(),
      )
      expect(buttonLabels).toContain('Stop')
      expect(container.textContent).toContain('Still working — reattached to the run.')

      // Then the lines the worker buffered while this panel was closed, and the
      // ones still streaming in.
      await push({ type: 'delta', text: 'The page is open. ' })
      await push({ type: 'tool.start', name: 'read_current_page' })
      await push({ type: 'tool.result', name: 'read_current_page', summary: '10 titles' })
      await push({ type: 'delta', text: 'Top story: one' })
      await push({
        type: 'confirm.request',
        requestId: 'r-1',
        name: 'fill',
        argsPreview: '{ css: ".q" }',
      })

      // One agent turn, so the continuation reads as the same reply.
      const turns = container.querySelectorAll('[data-role="assistant-turn"]')
      expect(turns).toHaveLength(1)
      const text = turns[0]?.textContent ?? ''
      // Progress continues AFTER the snapshot instead of being frozen by it, and
      // is not glued onto the last completed paragraph.
      expect(text.indexOf('The page is open.')).toBeGreaterThan(text.indexOf('opened news'))
      expect(text).toContain('10 titles')
      expect(text).toContain('Top story: one')
      expect(container.querySelectorAll('[data-kind="tool"]')).toHaveLength(2)
      // The placeholder made way for real progress.
      expect(text).not.toContain('reattached')
      // A question the turn raised while no panel was watching reaches this one.
      expect(container.querySelectorAll('.confirm-card')).toHaveLength(1)

      // Reconnecting again re-sends the same card; it must not stack two of them.
      await push({
        type: 'confirm.request',
        requestId: 'r-1',
        name: 'fill',
        argsPreview: '{ css: ".q" }',
      })
      expect(container.querySelectorAll('.confirm-card')).toHaveLength(1)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })
})

describe('phase elapsed clock · resets on each new wait', () => {
  // Drive the ticking clock without real timers: freeze `Date.now` and capture
  // the `window.setInterval` callbacks so the test fires them on demand. The
  // heartbeat shares `setInterval`, but its callback only posts a ping, so
  // invoking every captured callback is harmless.
  let currentTime = 0
  let intervalCallbacks: (() => void)[]

  beforeEach(() => {
    currentTime = 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime)
    intervalCallbacks = []
    vi.spyOn(window, 'setInterval').mockImplementation(((fn: () => void) => {
      intervalCallbacks.push(fn)
      return 1
    }) as unknown as typeof window.setInterval)
    vi.spyOn(window, 'clearInterval').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const elapsedOf = (container: HTMLElement): number => {
    const chip = container.querySelector('[data-elapsed-seconds]') as HTMLElement
    return Number(chip.dataset.elapsedSeconds)
  }

  const fireIntervals = async (): Promise<void> => {
    await act(async () => {
      for (const fn of intervalCallbacks) fn()
    })
  }

  it('counts one continuous pre-response wait, then restarts for the next round', async () => {
    const { container, root } = await renderChat()
    try {
      // A turn already running when the panel reattaches: the phase line opens
      // at the current clock.
      await push({
        type: 'restore',
        running: true,
        messages: [{ role: 'user', text: 'read the page' }],
      })

      // Preparing → sending → thinking reuse the SAME phase line before any
      // model output, so the wait keeps counting from the turn start — it must
      // not reset per phase label.
      currentTime = 18_000
      await fireIntervals()
      expect(elapsedOf(container)).toBe(8)

      // The model responds with a tool call: the phase line clears, then the
      // next round reopens it — a fresh wait whose clock restarts from here.
      await push({ type: 'tool.start', name: 'open_url' })
      await push({ type: 'tool.result', name: 'open_url', summary: 'opened' })
      currentTime = 30_000
      await push({ type: 'phase', phase: 'thinking' })

      // Two seconds since the reset at t=30s: the chip reads 2, not the 20 it
      // would show if it kept counting from the original turn start.
      currentTime = 32_000
      await fireIntervals()
      expect(elapsedOf(container)).toBe(2)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })
})
