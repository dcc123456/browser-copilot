// @vitest-environment jsdom
/**
 * The model section of the provider editor.
 *
 * Two behaviours the user depends on: the add-model field must start empty (a
 * prefilled value filters the fetched-model suggestions down to that entry),
 * and a provider must be able to hold several models with exactly one of them
 * in use.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ModelsTab from '../src/sidepanel/ModelsTab'
import { I18nProvider } from '../src/sidepanel/i18n'
import { messagesFor } from '../src/lib/i18n'
import type { Settings } from '../src/lib/types'
import type { ProviderProfile } from '../src/lib/providers'

const noop = () => {}
const roots: Root[] = []
const containers: HTMLElement[] = []

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

function settingsWith(provider: Partial<ProviderProfile>): Settings {
  return {
    providers: [
      {
        id: 'p1',
        label: 'Test provider',
        presetId: 'custom',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'k',
        model: 'deepseek-chat',
        ...provider,
      },
    ],
    activeProviderId: 'p1',
    locale: 'en',
    mode: 'semi',
    maxToolRounds: 20,
    disabledTools: [],
    systemPromptOverride: '',
    downloadAutoSave: true,
    imageModel: { providerId: '', model: '' },
    ocrLanguage: 'eng',
    localAgentEnabled: false,
    localAgentToken: '',
    localAgentUrl: 'ws://127.0.0.1:8765',
    localAgentActiveAgent: '',
    localAgentAdapterPath: '',
    localAgentAllowReload: false,
    localAgentBindings: {},
    unattendedWindowPolicy: 'latest',
    maxConcurrentRunWindows: 3,
    takeoverModel: { providerId: '', model: '' },
    takeoverOnRun: false,
    autoRepairOnRun: false,
    elementPickerEnabled: false,
    elementPickerFormat: 'html',
    elementPickerHideCard: false,
  } as Settings
}

beforeEach(() => {
  fetchedModels = []
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async (command: { type: string }) => {
        if (command.type === 'settings.get') {
          return { ok: true, data: { type: 'settings', settings: currentSettings } }
        }
        if (command.type === 'provider.models') {
          return { ok: true, data: { type: 'provider.models', models: fetchedModels } }
        }
        if (command.type === 'agent.status.get') {
          return { ok: true, data: { type: 'agent.status', status: null } }
        }
        if (command.type === 'agent.windows.list') {
          return { ok: true, data: { type: 'agent.windows', windows: [] } }
        }
        return { ok: true, data: { type: 'noop' } }
      }),
      onMessage: { addListener: noop, removeListener: noop },
    },
    storage: {
      local: { get: async () => ({}), set: async () => undefined },
      onChanged: { addListener: noop, removeListener: noop },
    },
  })
})

afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  for (const container of containers) container.remove()
  roots.length = 0
  containers.length = 0
  vi.unstubAllGlobals()
})

let currentSettings: Settings = settingsWith({})
let fetchedModels: string[] = []

async function openProviderEditor(settings: Settings): Promise<HTMLElement> {
  currentSettings = settings
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      createElement(
        I18nProvider,
        { value: { locale: 'en', t: messagesFor('en') } },
        createElement(ModelsTab),
      ),
    )
  })
  await act(async () => {
    await Promise.resolve()
  })

  const editButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Edit',
  )
  expect(editButton).toBeDefined()
  await act(async () => {
    editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  return container
}

async function typeIntoModelField(container: HTMLElement, value: string): Promise<void> {
  const input = container.querySelector('#p-model') as HTMLInputElement | null
  expect(input).not.toBeNull()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function clickButton(container: HTMLElement, label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  expect(button).toBeDefined()
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** The model names listed as added to the provider. */
function addedModels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('input[name="p-model-in-use"]')].map(
    (radio) => radio.closest('li')?.querySelector('span')?.textContent?.trim() ?? '',
  )
}

/** Ticks one of the fetched models in the multi-select list. */
async function checkFetchedModel(container: HTMLElement, name: string): Promise<void> {
  const label = [...container.querySelectorAll('label')].find(
    (candidate) =>
      candidate.textContent?.trim() === name && candidate.querySelector('input[type="checkbox"]'),
  )
  expect(label).toBeDefined()
  const checkbox = label?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
  await act(async () => {
    checkbox?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('the provider model list', () => {
  it('starts with an empty add field, so nothing filters the suggestions', async () => {
    const container = await openProviderEditor(
      settingsWith({ model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'] }),
    )

    const input = container.querySelector('#p-model') as HTMLInputElement | null
    expect(input?.value).toBe('')
    expect(addedModels(container)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
  })

  it('adds a model and makes it the one in use when the list was empty', async () => {
    const container = await openProviderEditor(settingsWith({ model: '', models: [] }))

    await typeIntoModelField(container, 'deepseek-reasoner')
    await clickButton(container, 'Add model')

    expect(addedModels(container)).toEqual(['deepseek-reasoner'])
    const radio = container.querySelector('input[name="p-model-in-use"]') as HTMLInputElement | null
    expect(radio?.checked).toBe(true)
  })

  it('keeps the models it already has when another one is added', async () => {
    const container = await openProviderEditor(
      settingsWith({ model: 'deepseek-chat', models: ['deepseek-chat'] }),
    )

    await typeIntoModelField(container, 'deepseek-reasoner')
    await clickButton(container, 'Add model')

    expect(addedModels(container)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
  })

  it('switches which model is in use', async () => {
    const container = await openProviderEditor(
      settingsWith({ model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'] }),
    )

    const radios = [...container.querySelectorAll('input[name="p-model-in-use"]')]
    await act(async () => {
      radios[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const checked = [...container.querySelectorAll('input[name="p-model-in-use"]')].map(
      (radio) => (radio as HTMLInputElement).checked,
    )
    expect(checked).toEqual([false, true])
  })

  it('hands the model in use over to the next one when it is removed', async () => {
    const container = await openProviderEditor(
      settingsWith({ model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'] }),
    )

    const removeButtons = [...container.querySelectorAll('button')].filter(
      (button) => button.textContent?.trim() === 'Remove',
    )
    await act(async () => {
      removeButtons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(addedModels(container)).toEqual(['deepseek-reasoner'])
    const checked = [...container.querySelectorAll('input[name="p-model-in-use"]')].map(
      (radio) => (radio as HTMLInputElement).checked,
    )
    expect(checked).toEqual([true])
  })

  it('adds several fetched models by ticking them, without a round trip per model', async () => {
    fetchedModels = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder']
    const container = await openProviderEditor(settingsWith({ model: '', models: [] }))

    await clickButton(container, 'Fetch models')
    await checkFetchedModel(container, 'deepseek-chat')
    await checkFetchedModel(container, 'deepseek-reasoner')

    expect(addedModels(container)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    const checked = [...container.querySelectorAll('input[name="p-model-in-use"]')].map(
      (radio) => (radio as HTMLInputElement).checked,
    )
    expect(checked).toEqual([true, false])

    // Unticking the model in use hands the selection to the next remaining one.
    await checkFetchedModel(container, 'deepseek-chat')
    expect(addedModels(container)).toEqual(['deepseek-reasoner'])
  })
})
