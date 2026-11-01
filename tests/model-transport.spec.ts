import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/llm', () => ({
  streamCompletion: vi.fn(),
}))
vi.mock('../src/background/web-chat/transport', () => ({
  streamWebChat: vi.fn(),
}))

import { streamCompletion } from '../src/lib/llm'
import { streamWebChat } from '../src/background/web-chat/transport'
import { streamModel } from '../src/background/model-transport'
import type { ProviderProfile } from '../src/lib/providers'
import type { StreamResult } from '../src/lib/llm'

const RESULT: StreamResult = {
  content: 'ok',
  reasoning: '',
  toolCalls: [],
  finishReason: 'stop',
  usage: null,
}

const httpProfile: ProviderProfile = {
  id: 'p1',
  label: 'DeepSeek',
  presetId: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'secret',
  model: 'deepseek-chat',
  headers: { 'X-Test': '1' },
}

const webProfile: ProviderProfile = {
  id: 'w1',
  label: 'DeepSeek Web',
  presetId: 'deepseek-web',
  transport: 'web',
  baseUrl: 'https://chat.deepseek.com/',
  apiKey: '',
  model: 'deepseek-web',
}

const call = { messages: [{ role: 'user' as const, content: 'hi' }] }

beforeEach(() => {
  vi.mocked(streamCompletion).mockReset().mockResolvedValue(RESULT)
  vi.mocked(streamWebChat).mockReset().mockResolvedValue(RESULT)
})

describe('streamModel', () => {
  it('delegates HTTP profiles with their credentials and headers', async () => {
    const handlers = { onText: vi.fn() }
    await expect(streamModel(httpProfile, call, handlers)).resolves.toEqual(RESULT)

    expect(streamCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'secret',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        headers: { 'X-Test': '1' },
        messages: call.messages,
      }),
      handlers,
    )
    expect(streamWebChat).not.toHaveBeenCalled()
  })

  it('delegates web profiles to the DOM transport, never HTTP', async () => {
    const handlers = { onText: vi.fn() }
    await expect(streamModel(webProfile, call, handlers)).resolves.toEqual(RESULT)

    expect(streamWebChat).toHaveBeenCalledWith(webProfile, call, handlers)
    expect(streamCompletion).not.toHaveBeenCalled()
  })
})
