// @vitest-environment jsdom
/**
 * The thinking-effort control in the provider editor.
 *
 * The panel is the only place where "this model does not support thinking
 * effort" can be told to the user, so the control itself is worth rendering:
 * the levels a vendor cannot express must not be selectable, a model
 * documented to reject the parameter must say so, and the request that will
 * go out must be spelled out.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ModelsTab from '../src/sidepanel/ModelsTab'
import { I18nProvider } from '../src/sidepanel/i18n'
import { messagesFor } from '../src/lib/i18n'
import type { Settings } from '../src/lib/types'

const noop = () => {}
const roots: Root[] = []
const containers: HTMLElement[] = []

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

/** A settings payload with one provider, as the worker would return it. */
function settingsWith(model: string, baseUrl: string): Settings {
  return {
    providers: [
      {
        id: 'p1',
        label: 'Test provider',
        presetId: 'custom',
        baseUrl,
        apiKey: 'k',
        model,
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
    elementPickerSelectOnly: false,
  } as Settings
}

beforeEach(() => {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async (command: { type: string }) => {
        if (command.type === 'settings.get') {
          return { ok: true, data: { type: 'settings', settings: currentSettings } }
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

let currentSettings: Settings = settingsWith('gpt-5', 'https://api.openai.com/v1')

/** Mounts the Settings tab and opens the provider editor on the first card. */
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
  // Let the settings round trip settle before the card is clicked.
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

/** Opens the advanced block of the provider editor. */
async function openAdvanced(container: HTMLElement): Promise<void> {
  const toggle = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Show advanced',
  )
  expect(toggle).toBeDefined()
  await act(async () => {
    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('the thinking-effort control', () => {
  it('offers the levels the vendor can express', async () => {
    const container = await openProviderEditor(
      settingsWith('deepseek-reasoner', 'https://api.deepseek.com/v1'),
    )
    await openAdvanced(container)

    const select = container.querySelector('#p-thinking') as HTMLSelectElement | null
    expect(select).not.toBeNull()
    const values = [...(select?.options ?? [])].map((option) => option.value)
    expect(values).toEqual(['', 'off', 'low', 'medium', 'high'])
    // DeepSeek documents no 'medium'; offering it as a choice would be a lie.
    const medium = [...(select?.options ?? [])].find((option) => option.value === 'medium')
    expect(medium?.disabled).toBe(true)
    const low = [...(select?.options ?? [])].find((option) => option.value === 'low')
    expect(low?.disabled).toBe(false)
  })

  it('spells out the parameters the request will carry', async () => {
    const container = await openProviderEditor(settingsWith('gpt-5', 'https://api.openai.com/v1'))
    await openAdvanced(container)

    const select = container.querySelector('#p-thinking') as HTMLSelectElement | null
    expect(select).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, 'high')
      select?.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(container.textContent).toContain('reasoning_effort=high')
  })

  it('says so when the model is documented to reject thinking control', async () => {
    const container = await openProviderEditor(
      settingsWith('gpt-4o-mini', 'https://api.openai.com/v1'),
    )
    await openAdvanced(container)

    expect(container.textContent).toContain('Model gpt-4o-mini does not support thinking effort')
  })

  it('warns when the endpoint carries no vendor information', async () => {
    const container = await openProviderEditor(
      settingsWith('qwen3:8b', 'http://localhost:11434/v1'),
    )
    await openAdvanced(container)

    expect(container.textContent).toContain('no vendor information')
  })

  it('follows the model when a vendor documents a different shape per model', async () => {
    const container = await openProviderEditor(
      settingsWith('MiniMax-M3.1-Flash', 'https://api.minimaxi.com/v1'),
    )
    await openAdvanced(container)

    const select = container.querySelector('#p-thinking') as HTMLSelectElement | null
    expect(select).not.toBeNull()
    const options = [...(select?.options ?? [])]
    // M3.1-Flash always thinks, so "off" is not a choice it can be given.
    expect(options.find((option) => option.value === 'off')?.disabled).toBe(true)
    expect(options.find((option) => option.value === 'high')?.disabled).toBe(false)

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, 'high')
      select?.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('reasoning_effort=xhigh')
  })

  it('offers no level for a model that always thinks', async () => {
    const container = await openProviderEditor(
      settingsWith('MiniMax-M2.5', 'https://api.minimaxi.com/v1'),
    )
    await openAdvanced(container)

    const select = container.querySelector('#p-thinking') as HTMLSelectElement | null
    expect(select).not.toBeNull()
    for (const option of [...(select?.options ?? [])]) {
      if (option.value === '') continue
      expect(option.disabled).toBe(true)
    }
    expect(container.textContent).toContain('Model MiniMax-M2.5 does not support thinking effort')
  })
})
