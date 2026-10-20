/**
 * Tests for the thinking-effort plumbing in `lib/llm`: the request body
 * carries the vendor's own parameters only when a level is set, the
 * connection probe exercises them, and a provider that rejects the parameter
 * is reported with the code the worker localizes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LlmError, streamCompletion, testConnection } from '../src/lib/llm'

/** A successful SSE response carrying one text delta and the terminator. */
function sseResponse(text = 'hi'): Response {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** A non-2xx response with a provider-style error body. */
function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status })
}

/** The JSON body of the Nth fetch call. */
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

const request = {
  apiKey: 'k',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5',
  messages: [{ role: 'user' as const, content: 'hi' }],
}

describe('streamCompletion thinking parameters', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("sends the vendor's parameters when a level is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse())
    vi.stubGlobal('fetch', fetchMock)

    await streamCompletion({ ...request, thinking: 'high' })

    expect(bodyOf(fetchMock)).toMatchObject({ reasoning_effort: 'high' })
  })

  it('sends nothing when no level is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse())
    vi.stubGlobal('fetch', fetchMock)

    await streamCompletion(request)

    const body = bodyOf(fetchMock)
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.reasoning).toBeUndefined()
    expect(body.thinking).toBeUndefined()
  })

  it('sends nothing for a model documented to reject the parameter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse())
    vi.stubGlobal('fetch', fetchMock)

    await streamCompletion({ ...request, model: 'gpt-4o-mini', thinking: 'high' })

    expect(bodyOf(fetchMock).reasoning_effort).toBeUndefined()
  })
})

describe('provider rejection of a thinking parameter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('flags the failure so the worker can explain it in the user language', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        errorResponse(
          400,
          "Unsupported parameter: 'reasoning_effort' is not supported with this model.",
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(streamCompletion({ ...request, thinking: 'high' })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof LlmError && error.code === 'unsupported-thinking' && error.status === 400,
    )
  })

  it('leaves other 400s unflagged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(400, 'context length exceeded'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(streamCompletion({ ...request, thinking: 'high' })).rejects.toSatisfy(
      (error: unknown) => error instanceof LlmError && error.code === undefined,
    )
  })
})

describe('testConnection with a thinking level', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exercises the thinking parameters instead of capping the reply at one token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await testConnection({
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
      thinking: 'high',
    })

    const body = bodyOf(fetchMock)
    expect(body.reasoning_effort).toBe('high')
    // A reasoning model spends its cap on reasoning tokens, so a cap of 1
    // would fail for a reason that has nothing to do with the profile.
    expect(body.max_tokens).toBeUndefined()
  })

  it('keeps the cheap probe when no thinking level is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await testConnection({
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
    })

    expect(bodyOf(fetchMock).max_tokens).toBe(1)
  })

  it('reports a model that rejects the parameter', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        errorResponse(
          400,
          "Unsupported parameter: 'reasoning_effort' is not supported with this model.",
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      testConnection({
        apiKey: 'k',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5',
        thinking: 'high',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof LlmError && error.code === 'unsupported-thinking',
    )
  })
})
