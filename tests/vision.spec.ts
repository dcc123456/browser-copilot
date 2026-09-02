import { describe, expect, it, vi } from 'vitest'
import {
  buildVisionRequestBody,
  defaultRecognitionPrompt,
  inspectImage,
  recognizeImage,
  resolveVisionTarget,
} from '../src/lib/vision'

const target = {
  baseUrl: 'https://vision.example.com/v1',
  apiKey: 'key',
  model: 'qwen-vl-plus',
  source: 'imageModel',
} as const

const arkProfile = {
  id: 'ark',
  label: 'Ark',
  presetId: 'ark',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  apiKey: 'k1',
  model: 'doubao-seed-code',
}
const chatProfile = {
  id: 'chat',
  label: 'Chat',
  presetId: 'custom',
  baseUrl: 'https://chat.example.com/v1',
  apiKey: 'k2',
  model: 'deepseek-chat',
}

describe('resolveVisionTarget', () => {
  it('reuses an explicitly selected provider’s credentials', () => {
    const result = resolveVisionTarget(
      { providerId: 'ark', model: '' },
      [arkProfile, chatProfile],
      chatProfile,
    )
    expect(result).toMatchObject({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'k1',
      model: 'doubao-seed-code',
      source: 'imageModel',
    })
  })

  it('lets a model override win over the provider default', () => {
    const result = resolveVisionTarget(
      { providerId: 'ark', model: 'qwen-vl-plus' },
      [arkProfile],
      undefined,
    )
    expect(result?.model).toBe('qwen-vl-plus')
  })

  it('falls back to the active provider when providerId is empty', () => {
    const result = resolveVisionTarget({ providerId: '', model: '' }, [arkProfile], chatProfile)
    expect(result).toMatchObject({ baseUrl: 'https://chat.example.com/v1', source: 'activeProvider' })
  })

  it('falls back to the active provider when the selected id is unknown', () => {
    const result = resolveVisionTarget({ providerId: 'ghost', model: '' }, [arkProfile], chatProfile)
    expect(result).toMatchObject({ source: 'activeProvider' })
  })

  it('returns null when nothing can be resolved', () => {
    expect(resolveVisionTarget({ providerId: '', model: '' }, [], undefined)).toBeNull()
  })

  it('ignores a selected provider that lacks credentials', () => {
    const broken = { ...arkProfile, apiKey: '', baseUrl: '' }
    const result = resolveVisionTarget({ providerId: 'ark', model: '' }, [broken], undefined)
    expect(result).toBeNull()
  })
})

describe('buildVisionRequestBody', () => {
  it('emits a single non-streaming multimodal completion', () => {
    const dataUrl = 'data:image/png;base64,abc'
    const body = buildVisionRequestBody(target, dataUrl, 'Read the CAPTCHA')
    expect(body.model).toBe('qwen-vl-plus')
    expect(body.stream).toBe(false)
    const content = (body.messages as { content: unknown[] }[])[0]?.content
    expect(content).toHaveLength(2)
    expect(content?.[1]).toEqual({ type: 'image_url', image_url: { url: dataUrl } })
  })
})

describe('defaultRecognitionPrompt', () => {
  it('asks for the characters verbatim without commentary', () => {
    const prompt = defaultRecognitionPrompt()
    expect(prompt).toMatch(/exactly as they appear/i)
    expect(prompt).toMatch(/ONLY the recognized content/i)
  })

  it('appends the user request when provided', () => {
    expect(defaultRecognitionPrompt('read the numbers')).toMatch(/User request: read the numbers/)
  })
})

describe('recognizeImage', () => {
  it('returns the trimmed text for a successful call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: ' 8Kf3 ' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await recognizeImage(target, 'data:image/png;base64,abc')
    expect(result).toEqual({ ok: true, text: '8Kf3' })
    vi.unstubAllGlobals()
  })

  it('maps an HTTP 401 to an API-key error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => '{"error":{"message":"bad key"}}',
      }),
    )
    const result = await recognizeImage(target, 'data:image/png;base64,abc')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/API key/)
    vi.unstubAllGlobals()
  })

  it('maps a network failure into a soft error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const result = await recognizeImage(target, 'data:image/png;base64,abc')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/Cannot reach/)
    vi.unstubAllGlobals()
  })

  it('propagates AbortError so the caller can cancel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    )
    await expect(
      recognizeImage(target, 'data:image/png;base64,abc', { signal: new AbortController().signal }),
    ).rejects.toThrow('aborted')
    vi.unstubAllGlobals()
  })
})

describe('inspectImage', () => {
  it('returns the model text for a successful inspection', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'A disabled blue submit button' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await inspectImage(target, 'data:image/png;base64,abc')
    expect(result).toEqual({ ok: true, text: 'A disabled blue submit button' })
    vi.unstubAllGlobals()
  })

  it('passes a custom prompt through to the model', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'The toast reads "Saved".' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    await inspectImage(target, 'data:image/png;base64,abc', { prompt: 'What does the toast say?' })
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as { body: string }
    const body = JSON.parse(init.body) as {
      messages: { role: string; content: { type: string; text: string }[] }[]
    }
    expect(
      body.messages[0]!.content.find((c) => c.type === 'text')?.text,
    ).toContain('What does the toast say?')
    vi.unstubAllGlobals()
  })

  it('maps a network failure into a soft error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const result = await inspectImage(target, 'data:image/png;base64,abc')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/Cannot reach/)
    vi.unstubAllGlobals()
  })
})