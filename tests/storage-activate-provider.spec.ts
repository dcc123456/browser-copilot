/**
 * `activateProvider` — the single settings write behind the chat composer's
 * model picker.
 *
 * The pointer and the profile's model live in one record, and a picker choice
 * changes both: writing them separately could leave the agent on a profile
 * whose `model` still names the previous choice. `chrome.storage.local` is
 * stubbed with an in-process map; with no directory handle in a plain Node run,
 * `fileStorageArea()` falls back to that mirror.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProviderProfile } from '../src/lib/providers'
import { activateProvider, getSettings, saveProvider } from '../src/lib/storage'

const data = new Map<string, unknown>()

beforeEach(() => {
  data.clear()
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        async get(keys: string | string[] | null) {
          if (!keys) return Object.fromEntries(data)
          const list = Array.isArray(keys) ? keys : [keys]
          const out: Record<string, unknown> = {}
          for (const key of list) if (data.has(key)) out[key] = data.get(key)
          return out
        },
        async set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) data.set(key, value)
        },
        async remove(keys: string | string[]) {
          for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key)
        },
      },
      session: {
        async get() {
          return {}
        },
        async set() {},
        async remove() {},
      },
    },
    runtime: { sendMessage: async () => ({}) },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function profile(id: string, label: string, model: string, models?: string[]): ProviderProfile {
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

describe('activateProvider', () => {
  it('switches the active profile and that profile model in one write', async () => {
    await saveProvider(profile('alpha', 'Alpha', 'a1', ['a1', 'a2']))
    await saveProvider(profile('beta', 'Beta', 'b1'))
    // The first saved profile becomes active; the picker then moves away.
    expect((await getSettings()).activeProviderId).toBe('alpha')

    const toBeta = await activateProvider('beta', 'b1')
    expect(toBeta.activeProviderId).toBe('beta')
    expect(toBeta.providers.find((entry) => entry.id === 'beta')?.model).toBe('b1')

    const backToAlpha = await activateProvider('alpha', 'a2')
    expect(backToAlpha.activeProviderId).toBe('alpha')
    expect(backToAlpha.providers.find((entry) => entry.id === 'alpha')?.model).toBe('a2')
    // Nothing else in the other profile moved.
    expect(backToAlpha.providers.find((entry) => entry.id === 'beta')?.model).toBe('b1')
  })

  it('only activates when the model is not one the profile lists', async () => {
    await saveProvider(profile('alpha', 'Alpha', 'a1', ['a1']))
    await saveProvider(profile('beta', 'Beta', 'b1'))

    const settings = await activateProvider('alpha', 'ghost')
    expect(settings.activeProviderId).toBe('alpha')
    expect(settings.providers.find((entry) => entry.id === 'alpha')?.model).toBe('a1')
  })

  it('falls back to the first profile for an unknown id', async () => {
    await saveProvider(profile('alpha', 'Alpha', 'a1'))
    await saveProvider(profile('beta', 'Beta', 'b1'))

    const settings = await activateProvider('deleted-profile')
    expect(settings.activeProviderId).toBe('alpha')
  })
})
