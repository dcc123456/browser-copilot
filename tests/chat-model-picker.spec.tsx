// @vitest-environment jsdom
/**
 * Component test for the composer's model picker and the icon-only actions,
 * driving the REAL ChatTab with a mocked command channel and port.
 *
 * Pinned here:
 * 1. the picker lists every model of every configured provider, grouped by
 *    provider, and starts on the profile Settings marked active;
 * 2. choosing a model is one `provider.activate` command carrying both the
 *    provider id and the model — never a panel-side settings write;
 * 3. a failed save moves the picker back and tells the user, instead of
 *    leaving the composer claiming a model the agent is not using;
 * 4. "new chat" and "send" are icon buttons: their label exists only as the
 *    accessible name (`tests/chat-save-dialog.spec.tsx` finds Send by it).
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

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Command } from '../src/lib/messages'
import ChatTab from '../src/sidepanel/ChatTab'

/** `\u001f` is the picker's provider/model separator (see ChatTab). */
const value = (providerId: string, model: string): string => `${providerId}\u001f${model}`

function profile(id: string, label: string, model: string, models?: string[]) {
  return {
    id,
    label,
    presetId: 'custom',
    baseUrl: `https://${id}.test/v1`,
    apiKey: 'key',
    model,
    ...(models ? { models } : {}),
  }
}

const ACTIVE_PROVIDERS = [
  profile('alpha', 'Alpha', 'a1', ['a1', 'a2']),
  profile('beta', 'Beta', 'b1'),
]

/** What the worker reports as settings; tests move the active pointer by id. */
type SettingsLike = {
  mode: string
  activeProviderId: string
  providers: ReturnType<typeof profile>[]
}

function settingsWithActive(activeId: string, model?: string): SettingsLike {
  return {
    mode: 'chat',
    activeProviderId: activeId,
    providers: ACTIVE_PROVIDERS.map((entry) =>
      entry.id === activeId && model ? { ...entry, model } : entry,
    ),
  }
}

let settingsReply: SettingsLike = settingsWithActive('alpha')
let activateError: Error | null = null

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

beforeEach(() => {
  portMessageListeners.length = 0
  fakePort.postMessage.mockReset()
  mocks.toast.mockReset()
  mocks.sendCommand.mockReset()
  settingsReply = settingsWithActive('alpha')
  activateError = null
  mocks.sendCommand.mockImplementation(async (command: Command) => {
    switch (command.type) {
      case 'history.list':
        return { type: 'history.list', entries: [] }
      case 'conversations.list':
        return { type: 'conversations.list', conversations: [] }
      case 'settings.get':
        return { type: 'settings', settings: settingsReply }
      case 'provider.activate': {
        if (activateError) throw activateError
        settingsReply = settingsWithActive(command.id, command.model)
        return { type: 'settings', settings: settingsReply }
      }
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

async function mountChat(withTranscript = false): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      createElement(ChatTab, { skills: [], activeSkillId: null, onSelectSkill: () => {} }),
    )
  })
  await flush()
  if (withTranscript) {
    await act(async () => {
      for (const listener of portMessageListeners) {
        listener({
          type: 'restore',
          messages: [
            { role: 'user', text: 'first question' },
            { role: 'assistant', text: 'answer one' },
          ],
          running: false,
        })
      }
    })
    await flush()
  }
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

const modelPicker = (scope: ParentNode): HTMLSelectElement | null =>
  scope.querySelector('select[aria-label="Model"]')

describe('chat model picker', () => {
  it('lists every model grouped by provider and starts on the active one', async () => {
    const mounted = await mountChat()
    const picker = modelPicker(mounted)
    expect(picker).not.toBeNull()
    expect([...(picker?.querySelectorAll('optgroup') ?? [])].map((g) => g.label)).toEqual([
      'Alpha',
      'Beta',
    ])
    expect([...(picker?.querySelectorAll('option') ?? [])].map((o) => o.value)).toEqual([
      value('alpha', 'a1'),
      value('alpha', 'a2'),
      value('beta', 'b1'),
    ])
    expect(picker?.value).toBe(value('alpha', 'a1'))
  })

  it('switches the model with one provider.activate command', async () => {
    const mounted = await mountChat()
    const picker = modelPicker(mounted)!
    await act(async () => {
      picker.value = value('alpha', 'a2')
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(mocks.sendCommand).toHaveBeenCalledWith({
      type: 'provider.activate',
      id: 'alpha',
      model: 'a2',
    })
    expect(picker.value).toBe(value('alpha', 'a2'))
  })

  it('moves back and reports when the switch could not be saved', async () => {
    activateError = new Error('settings write failed')
    const mounted = await mountChat()
    const picker = modelPicker(mounted)!
    await act(async () => {
      picker.value = value('beta', 'b1')
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(picker.value).toBe(value('alpha', 'a1'))
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    expect(String(mocks.toast.mock.calls[0]?.[0])).toContain('switch the model')
  })

  it('is absent until a provider is configured', async () => {
    settingsReply = { mode: 'chat', activeProviderId: '', providers: [] }
    const mounted = await mountChat()
    expect(modelPicker(mounted)).toBeNull()
  })
})

describe('composer actions are icons', () => {
  it('renders new chat and send without visible text but with their names', async () => {
    const mounted = await mountChat(true)
    const newChat = mounted.querySelector('button[aria-label="New chat"]')
    const send = mounted.querySelector('button[aria-label="Send"]')
    expect(newChat).not.toBeNull()
    expect(send).not.toBeNull()
    expect(newChat?.textContent?.trim()).toBe('')
    expect(send?.textContent?.trim()).toBe('')
  })
})
