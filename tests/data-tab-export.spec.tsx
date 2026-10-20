// @vitest-environment jsdom
/**
 * The Data tab's batch export and import.
 *
 * Two behaviours are worth pinning down: the export file holds exactly the
 * checked records, and an import creates NEW records instead of overwriting
 * the ones already on this machine.
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
import { buildDataExport } from '../src/lib/data-export'

const t = messagesFor('en')

const profile: UserProfile = {
  id: 'p1',
  label: 'Personal',
  email: 'ada@example.com',
  custom: { team: 'eng' },
  createdAt: 0,
  updatedAt: 0,
}

const secret: PasswordEntry = {
  id: 's1',
  label: 'GitHub',
  url: 'https://github.com',
  fields: [
    { key: 'username', value: 'ada' },
    { key: 'password', value: 'hunter2', secret: true },
  ],
  createdAt: 0,
  updatedAt: 0,
  useCount: 3,
}

const otherSecret: PasswordEntry = {
  id: 's2',
  label: 'Bank',
  fields: [{ key: 'pin', value: '1234', secret: true }],
  createdAt: 0,
  updatedAt: 0,
  useCount: 0,
}

let seen: Command[] = []
/** The JSON handed to the download helper, captured from the created blob. */
let downloaded: unknown = null

beforeEach(() => {
  seen = []
  downloaded = null
  mocks.sendCommand.mockReset()
  mocks.sendCommand.mockImplementation(async (command: Command): Promise<unknown> => {
    seen.push(command)
    switch (command.type) {
      case 'profiles.list':
        return { type: 'profiles.list', profiles: [profile] }
      case 'passwords.list':
        return { type: 'passwords.list', entries: [secret, otherSecret] }
      case 'profiles.save':
        return { type: 'profiles.save' }
      case 'passwords.save':
        return { type: 'passwords.save' }
      default:
        throw new Error(`unexpected command: ${command.type}`)
    }
  })
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => path },
    storage: { onChanged: { addListener: () => {}, removeListener: () => {} } },
  })
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob): string => {
      void blob.text().then((text) => {
        downloaded = JSON.parse(text)
      })
      return 'blob:mock'
    },
    revokeObjectURL: () => {},
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const render = async (): Promise<HTMLElement> => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(I18nProvider, { value: { locale: 'en' as const, t } }, createElement(DataTab)),
    )
  })
  await flush()
  return container
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((el) => el.textContent === label)
  if (!found) throw new Error(`button not found: ${label}`)
  return found
}

function checkboxFor(container: HTMLElement, label: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(
    `input[aria-label="${t.dataSelectItem({ label })}"]`,
  )
  if (!found) throw new Error(`checkbox not found: ${label}`)
  return found
}

async function openSection(container: HTMLElement, label: string): Promise<void> {
  await act(async () => {
    button(container, label).click()
  })
  await flush()
}

describe('data tab export and import', () => {
  it('exports exactly the checked secrets', async () => {
    const container = await render()
    await openSection(container, t.dataSecrets)

    await act(async () => {
      checkboxFor(container, secret.label).click()
    })
    await flush()

    await act(async () => {
      button(container, t.dataExportSelected).click()
    })
    await flush()

    const envelope = downloaded as ReturnType<typeof buildDataExport>
    expect(envelope.secrets).toHaveLength(1)
    expect(envelope.secrets[0]?.label).toBe(secret.label)
    expect(envelope.secrets[0]?.fields).toEqual(secret.fields)
    expect(envelope.profiles).toEqual([])
  })

  it('imports records as new entries without touching the stored ones', async () => {
    const container = await render()
    const file = {
      name: 'secrets-selected.json',
      text: async (): Promise<string> =>
        JSON.stringify(
          buildDataExport({
            secrets: [{ ...secret, id: 'from-file' } as PasswordEntry],
            profiles: [{ ...profile, id: 'from-file' } as UserProfile],
          }),
        ),
    } as unknown as File

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    Object.defineProperty(input!, 'files', { value: [file] })

    await act(async () => {
      input!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    const savedSecret = seen.find(
      (command): command is Extract<Command, { type: 'passwords.save' }> =>
        command.type === 'passwords.save',
    )
    const savedProfile = seen.find(
      (command): command is Extract<Command, { type: 'profiles.save' }> =>
        command.type === 'profiles.save',
    )
    expect(savedSecret).toBeDefined()
    expect(savedProfile).toBeDefined()
    expect(savedSecret?.entry.id).not.toBe('from-file')
    expect(savedSecret?.entry.id).not.toBe(secret.id)
    expect(savedSecret?.entry.label).toBe(secret.label)
    expect(savedSecret?.entry.useCount).toBe(0)
    expect(savedProfile?.profile.id).not.toBe('from-file')
    expect(savedProfile?.profile.id).not.toBe(profile.id)
    expect(savedProfile?.profile.custom).toEqual({ team: 'eng' })
  })

  it('rejects a file that is not an export file', async () => {
    const container = await render()
    const file = {
      name: 'other.json',
      text: async (): Promise<string> => JSON.stringify({ hello: 'world' }),
    } as unknown as File

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')
    Object.defineProperty(input!, 'files', { value: [file] })

    await act(async () => {
      input!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    expect(seen.some((command) => command.type === 'passwords.save')).toBe(false)
    expect(container.textContent).toContain(t.dataImportInvalid)
  })
})
