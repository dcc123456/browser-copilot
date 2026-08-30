import { describe, expect, it } from 'vitest'
import {
  PROVIDER_PRESETS,
  findPreset,
  isLocalEndpoint,
  normalizeBaseUrl,
  normalizeSettingsPayload,
  profileFromPreset,
  validateProfile,
  type ProviderProfile,
} from '../src/lib/providers'
import { normalizeStoredSettings } from '../src/lib/storage'

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'p1',
    label: 'Ark',
    presetId: 'ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'key',
    model: 'doubao-seed-code',
    ...overrides,
  }
}

describe('normalizeBaseUrl', () => {
  it('trims trailing slashes', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1')
    expect(normalizeBaseUrl('  https://api.deepseek.com/v1  ')).toBe(
      'https://api.deepseek.com/v1',
    )
  })

  it('strips a pasted /chat/completions suffix', () => {
    // Users copy the full endpoint from vendor docs; keeping it would 404.
    expect(normalizeBaseUrl('https://ark.cn-beijing.volces.com/api/v3/chat/completions')).toBe(
      'https://ark.cn-beijing.volces.com/api/v3',
    )
    expect(normalizeBaseUrl('https://api.openai.com/v1/chat/completions/')).toBe(
      'https://api.openai.com/v1',
    )
  })

  it('preserves the version segment, which differs per vendor', () => {
    expect(normalizeBaseUrl('https://ark.cn-beijing.volces.com/api/v3')).toBe(
      'https://ark.cn-beijing.volces.com/api/v3',
    )
  })
})

describe('presets', () => {
  it('exposes DeepSeek and Ark with correct bases', () => {
    expect(findPreset('deepseek')?.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(findPreset('ark')?.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3')
  })

  it('has unique ids and includes a custom escape hatch', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('custom')
  })

  it('builds an editable profile with no key prefilled', () => {
    const preset = findPreset('ark')!
    const built = profileFromPreset(preset, 'x1')
    expect(built).toMatchObject({ id: 'x1', presetId: 'ark', apiKey: '' })
    expect(built.model).toBe(preset.defaultModel)
  })
})

describe('preset endpoints', () => {
  it('zhipu exposes three or more candidate endpoints', () => {
    const zhipu = findPreset('zhipu')!
    expect(zhipu.endpoints?.length).toBeGreaterThanOrEqual(3)
    for (const ep of zhipu.endpoints ?? []) {
      expect(typeof ep.id).toBe('string')
      expect(typeof ep.title).toBe('string')
      expect(typeof ep.baseUrl).toBe('string')
    }
  })

  it('ark lists a coding-plan endpoint', () => {
    const ark = findPreset('ark')!
    const coding = (ark.endpoints ?? []).find((ep) => ep.id === 'ark-coding-plan')
    expect(coding).toBeDefined()
    expect(coding?.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/coding/v3')
  })

  it('keeps preset ids unique and includes the custom escape hatch', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('custom')
  })

  it('zhipu base is already normalized (no trailing slash)', () => {
    const zhipu = findPreset('zhipu')!
    expect(normalizeBaseUrl(zhipu.baseUrl)).toBe(zhipu.baseUrl)
    for (const ep of zhipu.endpoints ?? []) {
      expect(normalizeBaseUrl(ep.baseUrl)).toBe(ep.baseUrl)
    }
  })
})

describe('validateProfile', () => {
  it('accepts a complete profile', () => {
    expect(validateProfile(profile())).toEqual([])
  })

  it('reports each missing field', () => {
    const problems = validateProfile(
      profile({ label: '', baseUrl: '', apiKey: '', model: '' }),
    )
    expect(problems.map((problem) => problem.field).sort()).toEqual([
      'apiKey',
      'baseUrl',
      'label',
      'model',
    ])
  })

  it('rejects a base URL without an http scheme', () => {
    const problems = validateProfile(profile({ baseUrl: 'ark.cn-beijing.volces.com/api/v3' }))
    expect(problems).toHaveLength(1)
    expect(problems[0]!.field).toBe('baseUrl')
  })

  it('accepts a local http endpoint', () => {
    expect(validateProfile(profile({ baseUrl: 'http://localhost:11434/v1' }))).toEqual([])
  })
})

describe('isLocalEndpoint', () => {
  it('recognises loopback hosts', () => {
    expect(isLocalEndpoint('http://localhost:11434/v1')).toBe(true)
    expect(isLocalEndpoint('http://127.0.0.1:1234/v1')).toBe(true)
  })

  it('treats remote hosts as non-local', () => {
    expect(isLocalEndpoint('https://api.deepseek.com/v1')).toBe(false)
    expect(isLocalEndpoint('not a url')).toBe(false)
  })
})

/**
 * Stored settings are validated on read rather than trusted: a downgrade, a
 * hand-edit, or a half-written record must not be able to break the panel.
 */
describe('normalizeStoredSettings', () => {
  it('returns empty settings for absent or non-object input', () => {
    for (const input of [undefined, null, 'text', 42, {}]) {
      expect(normalizeStoredSettings(input)).toEqual({
        providers: [],
        activeProviderId: '',
        locale: 'auto',
        mode: 'semi',
        maxToolRounds: 20,
        disabledTools: [],
        systemPromptOverride: '',
      })
    }
  })

  it('passes a valid record through unchanged', () => {
    const settings = {
      providers: [profile()],
      activeProviderId: 'p1',
      locale: 'auto' as const,
      mode: 'full' as const,
      maxToolRounds: 25,
      disabledTools: [],
      systemPromptOverride: '',
    }
    expect(normalizeStoredSettings(settings)).toEqual(settings)
  })

  it('repairs a dangling active pointer', () => {
    const result = normalizeStoredSettings({ providers: [profile()], activeProviderId: 'gone' })
    expect(result.activeProviderId).toBe('p1')
  })

  it('drops malformed provider entries', () => {
    const result = normalizeStoredSettings({
      providers: [profile(), null, 'nope', { label: 'no id' }],
      activeProviderId: 'p1',
    })
    expect(result.providers).toHaveLength(1)
  })

  it('clears the pointer when no providers remain', () => {
    expect(normalizeStoredSettings({ providers: [], activeProviderId: 'p1' })).toEqual({
      providers: [],
      activeProviderId: '',
      locale: 'auto',
      mode: 'semi',
      maxToolRounds: 20,
      disabledTools: [],
      systemPromptOverride: '',
    })
  })

  it('coerces a non-array providers value to an empty list', () => {
    for (const bad of ['nope', 42, {}, null]) {
      expect(normalizeStoredSettings({ providers: bad }).providers).toEqual([])
    }
  })

  it('defaults the locale to auto, so the panel follows the browser', () => {
    expect(normalizeStoredSettings({ providers: [], activeProviderId: '' }).locale).toBe('auto')
  })

  it('preserves an explicit language choice', () => {
    const result = normalizeStoredSettings({
      providers: [profile()],
      activeProviderId: 'p1',
      locale: 'zh-CN',
    })
    expect(result.locale).toBe('zh-CN')
  })

  it('coerces an unsupported locale to auto rather than trusting it', () => {
    for (const bad of ['fr', 1, {}, null]) {
      const result = normalizeStoredSettings({
        providers: [profile()],
        activeProviderId: 'p1',
        locale: bad,
      })
      expect(result.locale).toBe('auto')
    }
  })
})

describe('normalizeSettingsPayload · cross-version safety', () => {
  // Regression: the panel crashed with "Cannot read properties of undefined
  // (reading 'length')" when a worker from another version answered without
  // `providers`, which unmounted the entire panel.
  it('survives a payload with no providers field', () => {
    const result = normalizeSettingsPayload({ activeProviderId: 'p1' })
    expect(result.providers).toEqual([])
    expect(() => result.providers.length).not.toThrow()
  })

  it('survives undefined, null, and non-object payloads', () => {
    for (const input of [undefined, null, 'text', 42, []]) {
      const result = normalizeSettingsPayload(input)
      expect(result.providers).toEqual([])
      expect(result.activeProviderId).toBe('')
      expect(result.locale).toBe('auto')
    }
  })

  it('coerces a non-array providers value to an empty list', () => {
    for (const bad of ['nope', 42, {}, null]) {
      expect(normalizeSettingsPayload({ providers: bad }).providers).toEqual([])
    }
  })

  it('keeps valid profiles and drops malformed entries', () => {
    const result = normalizeSettingsPayload({
      providers: [profile(), null, 'x', { label: 'no id' }],
      activeProviderId: 'p1',
    })
    expect(result.providers).toHaveLength(1)
    expect(result.activeProviderId).toBe('p1')
  })

  it('repairs an active pointer that names no known profile', () => {
    const result = normalizeSettingsPayload({
      providers: [profile()],
      activeProviderId: 'missing',
    })
    expect(result.activeProviderId).toBe('p1')
  })

  it('coerces an unknown locale to auto', () => {
    for (const bad of ['klingon', 1, {}, null, undefined]) {
      expect(normalizeSettingsPayload({ locale: bad }).locale).toBe('auto')
    }
    expect(normalizeSettingsPayload({ locale: 'zh-CN' }).locale).toBe('zh-CN')
    expect(normalizeSettingsPayload({ locale: 'en' }).locale).toBe('en')
  })
})
