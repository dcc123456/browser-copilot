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
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: () => {}, configurable: true })
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
      const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1)
    },
  },
  onDisconnect: { addListener: () => {}, removeListener: () => {} },
}

function workflowPayload(): unknown {
  return {
    id: 'w1', name: 'demo-submit', description: '', trigger: { type: 'manual' },
    settings: {}, table: [],
    drawflow: { nodes: [
      { id: 'n0', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger' } },
      { id: 'n1', label: 'click', position: { x: 0, y: 0 }, data: { blockId: 'event-click', selector: '.btn' } },
    ], edges: [{ id: 'e0', source: 'n0', target: 'n1' }] },
    createdAt: 1, updatedAt: 1,
  }
}

beforeEach(() => {
  listeners.length = 0; posted.length = 0
  mocks.sendCommand.mockReset()
  mocks.sendCommand.mockImplementation(async (command: { type: string }) => {
    switch (command.type) {
      case 'history.list': return { type: 'history.list', entries: [] }
      case 'conversations.list': return { type: 'conversations.list', conversations: [] }
      case 'settings.get': return { type: 'settings', settings: { mode: 'workflow' } }
      case 'settings.set': return { type: 'settings', settings: { mode: 'workflow' } }
      case 'workflows.draft.get': return { type: 'workflows.draft', workflow: workflowPayload() }
      case 'workflows.probe': return { type: 'workflows.probe', probes: null }
      default: throw new Error(`unexpected: ${command.type}`)
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
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

async function sendMessage(container: HTMLElement, text: string): Promise<void> {
  const textarea = container.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => { setter.call(textarea, text); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
  const sendButtons = [...container.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === 'Send' || b.textContent?.includes('Send'))
  // Prefer the composer send button (not 'Save as workflow').
  const send = container.querySelector('button[aria-label="Send"]') ?? sendButtons[0]!
  await act(async () => { send.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await flush()
}

describe('workflow generation inline progress and save card popup', () => {
  it('keeps progress inline while running, pops the save card popup on done', async () => {
    const container = document.createElement('div'); document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => { root.render(createElement(ChatTab, { skills: [], activeSkillId: null, onSelectSkill: () => {} })) })
      await flush()
      await sendMessage(container, 'click submit and confirm success')
      // Task running: NO loading dialog pops up — progress stays inline.
      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
      // Simulate a tool start/result as the background streams the task.
      await act(async () => { for (const l of listeners) l({ type: 'tool.start', name: 'wf_op_event-click' }) })
      await act(async () => { for (const l of listeners) l({ type: 'tool.result', name: 'wf_op_event-click', summary: 'node recorded' }) })
      expect(document.body.textContent ?? '').toContain('wf_op_event-click')
      expect(document.body.textContent ?? '').toContain('node recorded')
      // Still no popup mid-run.
      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
      // Turn ends: the save card popup replaces the loading dialog.
      await act(async () => { for (const l of listeners) l({ type: 'done' }) })
      await flush()
      const dialog = document.body.querySelector('[role="dialog"]')
      expect(dialog).not.toBeNull()
      expect(dialog!.getAttribute('aria-label')).toBe('demo-submit')
      const text = document.body.textContent ?? ''
      expect(text).toContain('demo-submit')
      expect(text).toContain('Save as workflow')
      expect(text).not.toContain('Generation log')
      // Closing the popup moves the card inline above the composer.
      const closeButton = document.body.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
      expect(closeButton).not.toBeNull()
      await act(async () => { closeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await flush()
      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
      expect(container.textContent).toContain('demo-submit')
      expect(container.textContent).toContain('Save as workflow')
    } finally {
      await act(async () => { root.unmount() })
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
        ctx.signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
      })
      return null
    }
    const run = executeOperatorNode('event-click', { selector: '.x' }, { signal: controller.signal, executors: { 'event-click': slow } })
    controller.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('aborting before execution throws AbortError', async () => {
    const controller = new AbortController(); controller.abort()
    const executor: BlockExecutor = async () => null
    await expect(
      executeOperatorNode('event-click', { selector: '.x' }, { signal: controller.signal, executors: { 'event-click': executor } }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})