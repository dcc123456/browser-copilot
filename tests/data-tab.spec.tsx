// @vitest-environment jsdom
/**
 * Component tests for the data tab (`sidepanel/DataTab`), driving the real
 * component with a mocked command channel. Pins the contract the tab owes the
 * user after the editors moved out of the list:
 *
 * 1. 编辑 opens the shared modal (role=dialog) carrying the stored values —
 *    for a profile AND for a password entry — and no inline editor card is
 *    left expanding the list behind it;
 * 2. saving goes through `profiles.save` / `passwords.save` and closes, while
 *    cancel closes without saving;
 * 3. a save that the worker rejects keeps the dialog open and reports the
 *    failure INSIDE it (role=alert) — the page banner sits behind the modal's
 *    backdrop, so surfacing it there would be invisible.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sendCommand: vi.fn() }))

vi.mock('../src/lib/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/messages')>()
  return { ...actual, sendCommand: mocks.sendCommand }
})

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Command } from '../src/lib/messages'
import type { PasswordEntry, UserProfile } from '../src/lib/types'
import { messagesFor } from '../src/lib/i18n'
import { I18nProvider } from '../src/sidepanel/i18n'
import DataTab from '../src/sidepanel/DataTab'

const t = messagesFor('en')

let profiles: UserProfile[] = []
let passwords: PasswordEntry[] = []
const seen: Command[] = []
let failNextSave: Error | null = null

function profile(id: string, label: string): UserProfile {
  return {
    id,
    label,
    fullName: `Name of ${label}`,
    email: `${id}@example.com`,
    custom: { birthday: '1990-01-01' },
    createdAt: 0,
    updatedAt: 0,
  }
}

function entry(id: string, label: string): PasswordEntry {
  return {
    id,
    label,
    url: 'https://example.com',
    fields: [
      { key: 'username', value: `user-${id}` },
      { key: 'password', value: `pw-${id}`, secret: true },
    ],
    createdAt: 0,
    updatedAt: 0,
    useCount: 0,
  }
}

/** Commands of one type the tab sent so far. */
const commands = (type: Command['type']): Command[] => seen.filter((entry) => entry.type === type)

beforeEach(() => {
  profiles = [profile('p-1', 'Personal')]
  passwords = [entry('s-1', 'GitHub')]
  seen.length = 0
  failNextSave = null
  mocks.sendCommand.mockReset()
  mocks.sendCommand.mockImplementation(async (command: Command): Promise<unknown> => {
    seen.push(command)
    switch (command.type) {
      case 'profiles.list':
        return { type: 'profiles.list', profiles }
      case 'passwords.list':
        return { type: 'passwords.list', entries: passwords }
      case 'profiles.save': {
        if (failNextSave) throw failNextSave
        profiles = [command.profile, ...profiles.filter((p) => p.id !== command.profile.id)]
        return { type: 'profiles.save' }
      }
      case 'passwords.save': {
        if (failNextSave) throw failNextSave
        passwords = [command.entry, ...passwords.filter((e) => e.id !== command.entry.id)]
        return { type: 'passwords.save' }
      }
      default:
        throw new Error(`unexpected command: ${command.type}`)
    }
  })
})

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount()
    })
  }
  document.body.innerHTML = ''
})

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const render = async (): Promise<{ container: HTMLElement }> => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      createElement(I18nProvider, { value: { locale: 'en' as const, t } }, createElement(DataTab)),
    )
  })
  await flush()
  return { container }
}

const click = async (root: ParentNode, label: string): Promise<void> => {
  const button = [...root.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!button) throw new Error(`no button labelled ${label}`)
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

/** Type into an input the way React sees it (the tracked setter). */
const type = async (input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

/** The open modal, if any — `FormDialog` renders in place, not through a portal. */
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]')

/** The labeled field's control inside a container. */
const fieldInput = (root: ParentNode, label: string): HTMLInputElement => {
  const field = [...root.querySelectorAll('label.field')].find(
    (candidate) => candidate.querySelector('span')?.textContent?.trim() === label,
  )
  const input = field?.querySelector('input')
  if (!input) throw new Error(`no field labelled ${label}`)
  return input
}

describe('data tab · profile editing opens a dialog', () => {
  it('carries the stored values into a modal and saves through profiles.save', async () => {
    const { container } = await render()
    expect(dialog()).toBeNull()

    await click(container, t.edit)

    const panel = dialog()
    expect(panel).not.toBeNull()
    expect(panel?.getAttribute('aria-label')).toBe('Personal')
    expect(fieldInput(panel!, t.dataProfileLabel).value).toBe('Personal')
    expect(fieldInput(panel!, t.dataEmail).value).toBe('p-1@example.com')
    // The custom-fields text is serialized from the stored map.
    expect(panel?.querySelector('textarea')?.value).toBe('birthday = 1990-01-01')

    await type(fieldInput(panel!, t.dataEmail), 'new@example.com')
    await click(panel!, t.save)

    const saves = commands('profiles.save')
    expect(saves).toHaveLength(1)
    expect(saves[0]).toMatchObject({
      type: 'profiles.save',
      profile: { id: 'p-1', email: 'new@example.com', custom: { birthday: '1990-01-01' } },
    })
    expect(dialog()).toBeNull()
  })

  it('creates a profile in the same dialog, gated on the label', async () => {
    const { container } = await render()
    await click(container, t.dataAddProfile)

    const panel = dialog()
    expect(panel).not.toBeNull()
    expect(panel?.getAttribute('aria-label')).toBe(t.dataAddProfile)
    const save = [...(panel?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === t.save,
    )
    expect(save?.hasAttribute('disabled')).toBe(true)

    await type(fieldInput(panel!, t.dataProfileLabel), 'Work')
    expect(save?.hasAttribute('disabled')).toBe(false)
  })

  it('cancels without sending profiles.save', async () => {
    const { container } = await render()
    await click(container, t.edit)
    expect(dialog()).not.toBeNull()

    await click(dialog()!, t.cancel)

    expect(commands('profiles.save')).toHaveLength(0)
    expect(dialog()).toBeNull()
  })

  it('keeps the dialog open and reports inside it when the save fails', async () => {
    const { container } = await render()
    await click(container, t.edit)
    failNextSave = new Error('disk full')

    await click(dialog()!, t.save)

    const panel = dialog()
    expect(panel).not.toBeNull()
    expect(panel?.querySelector('[role="alert"]')?.textContent).toBe('disk full')
  })
})

describe('data tab · password editing opens a dialog', () => {
  const openSecrets = async (container: HTMLElement): Promise<void> => {
    await click(container, t.dataSecrets)
  }

  it('carries the stored fields into a modal and saves through passwords.save', async () => {
    const { container } = await render()
    await openSecrets(container)
    expect(dialog()).toBeNull()

    await click(container, t.edit)

    const panel = dialog()
    expect(panel).not.toBeNull()
    expect(panel?.getAttribute('aria-label')).toBe('GitHub')
    expect(fieldInput(panel!, t.dataSecretLabel).value).toBe('GitHub')
    // Secret fields stay masked inside the dialog until revealed there.
    const value = panel?.querySelector<HTMLInputElement>('input.kv-value')
    expect(value?.value).toBe('user-s-1')
    expect(panel?.querySelectorAll('input.kv-value')[1]?.getAttribute('type')).toBe('password')

    await type(value!, 'renamed-user')
    await click(panel!, t.save)

    const saves = commands('passwords.save')
    expect(saves).toHaveLength(1)
    expect(saves[0]).toMatchObject({ type: 'passwords.save', entry: { id: 's-1' } })
    const saved = (saves[0] as { entry: PasswordEntry }).entry
    expect(saved.fields[0]).toEqual({ key: 'username', value: 'renamed-user' })
    expect(saved.fields[1]).toEqual({ key: 'password', value: 'pw-s-1', secret: true })
    expect(dialog()).toBeNull()
  })

  it('cancels without sending passwords.save', async () => {
    const { container } = await render()
    await openSecrets(container)
    await click(container, t.edit)
    expect(dialog()).not.toBeNull()

    await click(dialog()!, t.cancel)

    expect(commands('passwords.save')).toHaveLength(0)
    expect(dialog()).toBeNull()
  })
})
