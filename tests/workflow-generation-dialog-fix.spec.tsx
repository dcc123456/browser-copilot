// @vitest-environment jsdom
/**
 * Bug-fix acceptance:
 * 1. workflow-generation mode keeps progress INLINE in the chat stream: no
 *    loading dialog pops on send — the tool steps stream in the message list —
 *    and only when the turn settles does the save card popup appear;
 * 2. stop must immediately terminate background work: aborting the turn
 *    signal makes operator execution/wait throw AbortError instead of being
 *    swallowed into a failed/partial result the model can continue from.
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
import { createRoot } from 'react-dom/client'
import { executeOperatorNode } from '../src/background/workflow-engine/operator-exec'
import type { BlockExecutor } from '../src/background/workflow-engine/executors'
import ChatTab from '../src/sidepanel/ChatTab'

const listeners: ((message: unknown) => void)[] = []
const posted: unknown[] = []
const fakePort = {
  postMessage: vi.fn((m: unknown) => posted.push(m)),
  disconnect: vi.fn(),
  onMessage: {
    addListener: (fn: (message: unknown) => void) => listeners.push(fn),
    removeListener: (fn: (message: unknown) => void) => {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    },
  },
  onDisconnect: { addListener: () => {}, removeListener: () => {} },
}

function workflowPayload(): unknown {
  return {
    id: 'w1',
    name: 'demo-submit',
    description: '',
    trigger: { type: 'manual' },
    settings: {},
    table: [],
    drawflow: {
      nodes: [
        { id: 'n0', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger' } },
        {
          id: 'n1',
          label: 'click',
          position: { x: 0, y: 0 },
          data: { blockId: 'event-click', selector: '.btn' },
        },
      ],
      edges: [{ id: 'e0', source: 'n0', target: 'n1' }],
    },
    createdAt: 1,
    updatedAt: 1,
  }
}

beforeEach(() => {
  listeners.length = 0
  posted.length = 0
  mocks.sendCommand.mockReset()
  mocks.sendCommand.mockImplementation(async (command: { type: string }) => {
    switch (command.type) {
      case 'history.list':
        return { type: 'history.list', entries: [] }
      case 'conversations.list':
        return { type: 'conversations.list', conversations: [] }
      case 'settings.get':
        return { type: 'settings', settings: { mode: 'workflow' } }
      case 'settings.set':
        return { type: 'settings', settings: { mode: 'workflow' } }
      case 'workflows.draft.get':
        return { type: 'workflows.draft', workflow: workflowPayload() }
      case 'workflows.probe':
        return { type: 'workflows.probe', probes: null }
      default:
        throw new Error(`unexpected: ${command.type}`)
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
afterEach(() => vi.unstubAllGlobals())

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** Type into the composer textarea the way a real keystroke does. */
async function typeInto(container: HTMLElement, text: string): Promise<void> {
  const textarea = container.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!
  await act(async () => {
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Click a button by its visible label, in the panel or in a body portal. */
async function clickButton(label: string, scope: ParentNode = document.body): Promise<boolean> {
  const button = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!button) return false
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
  return true
}

/** Push one worker message to every panel listener. */
async function emit(message: unknown): Promise<void> {
  await act(async () => {
    for (const l of listeners) l(message)
  })
  await flush()
}

const composerValue = (container: HTMLElement): string =>
  container.querySelector('textarea')?.value ?? ''

/** The panel's conversation, as the stubbed storage leaves it. */
const CONV = 'default'

async function sendMessage(container: HTMLElement, text: string): Promise<void> {
  await typeInto(container, text)
  const sendButtons = [...container.querySelectorAll('button')].filter(
    (b) => b.getAttribute('aria-label') === 'Send' || b.textContent?.includes('Send'),
  )
  // Prefer the composer send button (not 'Save as workflow').
  const send = container.querySelector('button[aria-label="Send"]') ?? sendButtons[0]!
  await act(async () => {
    send.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
  // Workflow generation confirms the workflow NAME before dispatching the
  // turn: accept the suggested name so the task actually posts.
  await clickButton('Start task')
}

describe('workflow generation inline progress and save card popup', () => {
  it('keeps progress inline while running, pops the save card popup on done', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(
          createElement(ChatTab, { skills: [], activeSkillId: null, onSelectSkill: () => {} }),
        )
      })
      await flush()
      await sendMessage(container, 'click submit and confirm success')
      // Task running: NO loading dialog pops up — progress stays inline.
      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
      // Simulate a tool start/result as the background streams the task.
      await act(async () => {
        for (const l of listeners) l({ type: 'tool.start', name: 'wf_op_event-click' })
      })
      await act(async () => {
        for (const l of listeners)
          l({ type: 'tool.result', name: 'wf_op_event-click', summary: 'node recorded' })
      })
      expect(document.body.textContent ?? '').toContain('wf_op_event-click')
      expect(document.body.textContent ?? '').toContain('node recorded')
      // Still no popup mid-run.
      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
      // Turn ends: the save card popup replaces the loading dialog.
      await act(async () => {
        for (const l of listeners) l({ type: 'done' })
      })
      await flush()
      const dialog = document.body.querySelector('[role="dialog"]')
      expect(dialog).not.toBeNull()
      expect(dialog!.getAttribute('aria-label')).toBe('demo-submit')
      const text = document.body.textContent ?? ''
      expect(text).toContain('demo-submit')
      expect(text).toContain('Save as workflow')
      expect(text).not.toContain('Generation log')
      // Closing the popup moves the card inline above the composer.
      const closeButton = document.body.querySelector<HTMLButtonElement>(
        'button[aria-label="Run in background"]',
      )
      expect(closeButton).not.toBeNull()
      await act(async () => {
        closeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()
      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
      expect(container.textContent).toContain('demo-submit')
      expect(container.textContent).toContain('Save as workflow')
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })
})

describe('immediate stop of background work', () => {
  it('an operator waiting on the signal throws AbortError when aborted (not a failed result)', async () => {
    const controller = new AbortController()
    const slow: BlockExecutor = async (_data, ctx) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 5000)
        ctx.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            reject(new DOMException('Aborted', 'AbortError'))
          },
          { once: true },
        )
      })
      return null
    }
    const run = executeOperatorNode(
      'event-click',
      { selector: '.x' },
      { signal: controller.signal, executors: { 'event-click': slow } },
    )
    controller.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('aborting before execution throws AbortError', async () => {
    const controller = new AbortController()
    controller.abort()
    const executor: BlockExecutor = async () => null
    await expect(
      executeOperatorNode(
        'event-click',
        { selector: '.x' },
        { signal: controller.signal, executors: { 'event-click': executor } },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

/**
 * The composer while a turn is running: a typed instruction joins the task
 * already in flight instead of starting a second one (the user should not have
 * to Stop and re-send to add a constraint), and it is never silently dropped —
 * a note the turn never read comes back to the input. Plus the card rule that
 * goes with it: one question on screen, and no card left pending on a stopped
 * turn.
 */
describe('supplements into the running turn', () => {
  /** Mount the panel, run a task, and hand back what the port was given. */
  async function mountBusy(): Promise<{
    container: HTMLElement
    unmount: () => Promise<void>
    postedOfType: (type: string) => Record<string, unknown>[]
  }> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(ChatTab, { skills: [], activeSkillId: null, onSelectSkill: () => {} }),
      )
    })
    await flush()
    await sendMessage(container, 'click submit and confirm success')
    return {
      container,
      unmount: async () => {
        await act(async () => {
          root.unmount()
        })
        container.remove()
      },
      postedOfType: (type) =>
        posted.filter((m) => (m as { type: string }).type === type) as Record<string, unknown>[],
    }
  }

  it('queues onto the live turn instead of opening a second one', async () => {
    const { container, unmount, postedOfType } = await mountBusy()
    try {
      await typeInto(container, 'use the second account')
      expect(await clickButton('Supplement', container)).toBe(true)

      const chats = postedOfType('chat')
      expect(chats).toHaveLength(1)
      const notes = postedOfType('chat.interject')
      expect(notes).toHaveLength(1)
      expect(notes[0]).toMatchObject({ text: 'use the second account', conversationId: CONV })
      expect(typeof notes[0]!.noteId).toBe('string')
      // The composer is free again, and the note shows as a user message.
      expect(composerValue(container)).toBe('')
      expect(container.textContent).toContain('use the second account')
    } finally {
      await unmount()
    }
  })

  it('stops flagging the note once the turn says it applied it', async () => {
    const { container, unmount, postedOfType } = await mountBusy()
    try {
      await typeInto(container, 'also collect the price')
      await clickButton('Supplement', container)
      expect(container.textContent).toContain('Queued for the running task')

      const noteId = postedOfType('chat.interject')[0]!.noteId as string
      await emit({ type: 'chat.interjection.applied', conversationId: CONV, noteIds: [noteId] })

      // An applied note is just a user turn now: no flag, and the text is not
      // handed back when the turn ends.
      expect(container.textContent).not.toContain('Queued for the running task')
      await emit({ type: 'done' })
      expect(composerValue(container)).not.toContain('also collect the price')
    } finally {
      await unmount()
    }
  })

  it('returns a note the turn never read to the composer', async () => {
    const { container, unmount } = await mountBusy()
    try {
      await typeInto(container, 'skip the preview step')
      await clickButton('Supplement', container)

      // Stop, and the turn ends without ever reaching the note.
      await clickButton('Stop', container)
      await emit({ type: 'done' })

      expect(container.textContent).toContain('Not applied')
      expect(composerValue(container)).toContain('skip the preview step')
    } finally {
      await unmount()
    }
  })

  it('sends for real when the turn finished before the note landed', async () => {
    const { container, unmount, postedOfType } = await mountBusy()
    try {
      await typeInto(container, 'one more thing')
      await clickButton('Supplement', container)
      const noteId = postedOfType('chat.interject')[0]!.noteId as string

      await emit({ type: 'chat.interject.ack', conversationId: CONV, noteId, queued: false })

      // The same words go out as an ordinary message — once, not twice.
      const chats = postedOfType('chat')
      expect(chats).toHaveLength(2)
      expect(String(chats[1]!.text)).toBe('one more thing')
      const shown = [...container.querySelectorAll('.msg[data-role="user"]')].filter((node) =>
        node.textContent?.includes('one more thing'),
      )
      expect(shown).toHaveLength(1)
    } finally {
      await unmount()
    }
  })
})

describe('one question card at a time', () => {
  it('shows the oldest question alone, and drops it when the turn ends', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(
          createElement(ChatTab, { skills: [], activeSkillId: null, onSelectSkill: () => {} }),
        )
      })
      await flush()

      await emit({
        type: 'ask_user.request',
        requestId: 'q1',
        question: 'Which account?',
        options: [{ label: 'A', pros: 'fast', cons: 'risky' }],
      })
      await emit({
        type: 'ask_user.request',
        requestId: 'q2',
        question: 'Overwrite the draft?',
        options: [{ label: 'B', pros: 'safe', cons: 'slow' }],
      })

      const cards = container.querySelectorAll('[data-kind="ask"]')
      expect(cards).toHaveLength(1)
      expect(cards[0]!.textContent).toContain('Which account?')

      // Stop takes the card with the turn: leaving it up means a click that
      // answers nothing and a task stuck waiting on a settled promise.
      await emit({ type: 'interactions.dismissed', conversationId: CONV })
      expect(container.querySelectorAll('[data-kind="ask"]')).toHaveLength(0)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })
})
