import { afterEach, describe, expect, it, vi } from 'vitest'

import { LlmError, streamCompletion } from '../src/lib/llm'

const encoder = new TextEncoder()

function streamResponse(frames: string[]): Response {
  let next = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < frames.length) {
        controller.enqueue(encoder.encode(frames[next]))
        next += 1
        return
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const OK_STREAM = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
]

const message = [{ role: 'user' as const, content: 'Say OK' }]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('keyless completions', () => {
  it('sends no Authorization header to a keyless endpoint', async () => {
    let captured: RequestInit | undefined
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      captured = init
      return streamResponse(OK_STREAM)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await streamCompletion({
      apiKey: '',
      baseUrl: 'https://text.pollinations.ai/openai',
      model: 'openai-fast',
      messages: message,
    })

    expect(result.content).toBe('OK')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const headers = new Headers(captured?.headers)
    expect(headers.has('Authorization')).toBe(false)
  })

  it('still rejects an empty key for a keyed endpoint', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      streamCompletion({
        apiKey: '',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        messages: message,
      }),
    ).rejects.toBeInstanceOf(LlmError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
