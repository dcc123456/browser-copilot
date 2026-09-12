/**
 * Tests for the transient-failure retry in `streamCompletion` (`lib/llm`):
 * 429 / 5xx / network failures are retried with backoff, permanent 4xx errors
 * are surfaced immediately, and a persistent failure ends with a transient
 * `LlmError` after the attempt budget is spent. `fetch` is stubbed, so no
 * network is touched; the real SSE accumulator parses the stub responses.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LLM_MAX_ATTEMPTS, LlmError, isTransientLlmError, streamCompletion } from '../src/lib/llm'

/** A successful SSE response carrying one text delta and the terminator. */
function sseResponse(text = 'hi'): Response {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** A non-2xx response with a provider-style error body. */
function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: { message: 'boom' } }), { status })
}

const request = {
  apiKey: 'k',
  baseUrl: 'https://api.example.com/v1',
  model: 'm',
  messages: [{ role: 'user' as const, content: 'hi' }],
}

describe('streamCompletion transient retry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries a 503 and then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(sseResponse('recovered'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await streamCompletion(request)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.content).toContain('recovered')
  })

  it('does NOT retry a permanent 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401))
    vi.stubGlobal('fetch', fetchMock)

    await expect(streamCompletion(request)).rejects.toBeInstanceOf(LlmError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(streamCompletion(request)).rejects.toSatisfy(
      (error: unknown) => !isTransientLlmError(error),
    )
  })

  it('retries a transport failure and then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(sseResponse('ok'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await streamCompletion(request)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.content).toContain('ok')
  })

  it('exhausts the attempt budget on a persistent 500 and throws a transient error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(500))
    vi.stubGlobal('fetch', fetchMock)

    let caught: unknown
    try {
      await streamCompletion(request)
    } catch (error) {
      caught = error
    }
    expect(fetchMock).toHaveBeenCalledTimes(LLM_MAX_ATTEMPTS)
    expect(caught).toBeInstanceOf(LlmError)
    expect(isTransientLlmError(caught)).toBe(true)
  })

  it('never retries an aborted request', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(streamCompletion({ ...request, signal: controller.signal })).rejects.toSatisfy(
      (error: unknown) => (error as Error)?.name === 'AbortError',
    )
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })
})
