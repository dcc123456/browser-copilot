// @vitest-environment jsdom
/**
 * Component test for the composer's input gestures, driving the REAL ChatTab
 * with a mocked command channel and port. Pinned here:
 *
 * 1. a slash-picked skill consumes the `/term` from the draft and pins the
 *    skill for the next turn only — after the turn is handed over the tag is
 *    gone again (one-shot invocation);
 * 2. that tag sits INSIDE the input field, on the same line as the text, and
 *    survives a reload through the stored `skillName`;
 * 3. a typed `@` opens the file picker and never lands in the message;
 * 4. the placeholder advertises both gestures (`/` and `@`).
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

import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Command } from '../src/lib/messages'
import type { Skill } from '../src/lib/types'
import ChatTab from '../src/sidepanel/ChatTab'

const skill = (id: string, name: string, description = ''): Skill => ({
  id,
  name,
  description,
  instructions: 'body',
  autoMatch: false,
  createdAt: 1,
  updatedAt: 1,
})
const TRANS = skill('s1', 'trans', 'Translate the selected text')

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
  mocks.sendCommand.mockImplementation(async (command: Command) => {
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

interface TestProps {
  skills?: Skill[]
  activeSkillId?: string | null
  onSelectSkill?: (id: string | null) => void
}

async function mount(props: TestProps = {}): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      createElement(ChatTab, {
        skills: props.skills ?? [],
        activeSkillId: props.activeSkillId ?? null,
        onSelectSkill: props.onSelectSkill ?? (() => {}),
      }),
    )
  })
  await flush()
  return container
}

/** Mounts with a parent that really owns the active skill, like App does. */
async function mountWithPin(initialSkillId: string): Promise<HTMLDivElement> {
  function Harness() {
    const [activeSkillId, setActiveSkillId] = useState<string | null>(initialSkillId)
    return createElement(ChatTab, {
      skills: [TRANS],
      activeSkillId,
      onSelectSkill: setActiveSkillId,
    })
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(Harness))
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

const composer = (scope: ParentNode): HTMLTextAreaElement =>
  scope.querySelector('textarea') as HTMLTextAreaElement

/** Types `text` with the caret at `caret` (default: end), like a keyboard would. */
async function typeInto(text: string, caret = text.length): Promise<HTMLTextAreaElement> {
  const field = composer(container!)
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field, text)
    field.setSelectionRange(caret, caret)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
  return field
}

async function restoreMessages(
  messages: { role: 'user' | 'assistant'; text: string; skillName?: string }[],
): Promise<void> {
  await act(async () => {
    for (const listener of portMessageListeners) {
      listener({ type: 'restore', messages, running: false })
    }
  })
  await flush()
}

describe('composer slash commands', () => {
  it('consumes the typed command and pins the skill when picked', async () => {
    const onSelectSkill = vi.fn()
    await mount({ skills: [TRANS], onSelectSkill })
    const field = await typeInto('/tr')
    const items = [...container!.querySelectorAll<HTMLButtonElement>('.slash-item')]
    expect(items.map((item) => item.textContent)).toEqual([expect.stringContaining('/trans')])
    await act(async () => {
      items[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    await flush()
    expect(onSelectSkill).toHaveBeenCalledWith('s1')
    expect(field.value).toBe('')
  })

  it('shows the active skill as a tag that only indents the first line', async () => {
    await mount({ skills: [TRANS], activeSkillId: 's1' })
    const chip = container!.querySelector('.skill-chip')
    const field = composer(container!)
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toContain('/trans')
    // The tag overlays the field's first line instead of eating its width.
    expect(chip?.parentElement).toBe(field.parentElement)
    expect(chip?.className).toContain('absolute')
    // The textarea keeps the full width; only its first line starts after the tag.
    expect(field.className).toContain('w-full')
    expect(Number.parseInt(field.style.textIndent || '0', 10)).toBeGreaterThan(0)
  })

  it('uses the skill for one turn only', async () => {
    await mountWithPin('s1')
    expect(container!.querySelector('.skill-chip')).not.toBeNull()
    await typeInto('translate this')
    const send = container!.querySelector('button[aria-label="Send"]') as HTMLButtonElement
    await act(async () => {
      send.click()
    })
    await flush()
    expect(fakePort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat', text: 'translate this', skillId: 's1' }),
    )
    // The tag moved into the transcript with the turn; the composer is clean.
    const field = composer(container!)
    expect(field.parentElement?.querySelector('.skill-chip')).toBeNull()
    const bubble = container!.querySelector('.msg[data-role="user"]')
    expect(bubble?.querySelector('.skill-chip')?.textContent).toContain('/trans')
  })

  it('keeps the tag on a restored turn', async () => {
    await mount()
    await restoreMessages([
      { role: 'user', text: 'translate it', skillName: 'trans' },
      { role: 'assistant', text: 'done' },
    ])
    const tag = container!.querySelector('.msg[data-role="user"] .skill-chip')
    expect(tag?.textContent).toContain('/trans')
    expect(container!.querySelector('.msg[data-role="user"]')?.textContent).toContain(
      'translate it',
    )
  })
})

describe('composer @ attachment trigger', () => {
  it('opens the file picker and keeps the @ out of the message', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click')
    await mount()
    // Type the word, then the `@`: the trigger only fires on the keystroke.
    await typeInto('hello ')
    const field = await typeInto('hello @')
    expect(click).toHaveBeenCalledTimes(1)
    expect(field.value).toBe('hello ')
    click.mockRestore()
  })

  it('names both gestures in the placeholder', async () => {
    await mount()
    const placeholder = composer(container!).placeholder
    expect(placeholder).toContain('/')
    expect(placeholder).toContain('@')
  })
})
