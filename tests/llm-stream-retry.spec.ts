/**
 * Tests for the caller-owned retry/continuation path in `streamCompletion`
 * (`lib/llm`): a stream that dies before any text resends the same request, a
 * stream that dies after text resumes from the partial answer, tool-call
 * fragments are never resumed, the idle watchdog cuts only silence (never a
 * long reply that keeps talking), and the default (no policy) behavior stays
 * terminal after the body was consumed.
 *
 * `fetch` is stubbed; real `Response` + `ReadableStream` objects exercise the
 * SSE accumulator and the reader loop.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  LlmError,
  streamCompletion,
  type StreamContinueInfo,
  type StreamRetryInfo,
} from '../src/lib/llm'

const encoder = new TextEncoder()

/** SSE frame carrying a text delta. */
function textFrame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
}

/** SSE frame saying the answer was cut by the provider's output-token cap. */
const LENGTH_FRAME = `data: ${JSON.stringify({
  choices: [{ delta: {}, finish_reason: 'length' }],
})}\n\n`

/** SSE frame saying the answer finished on its own. */
const STOP_FRAME = `data: ${JSON.stringify({
  choices: [{ delta: {}, finish_reason: 'stop' }],
})}\n\n`

/** SSE frame carrying a tool-call fragment. */
function toolFrame(name: string, args = '{"a"'): string {
  return `data: ${JSON.stringify({
    choices: [
      { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: args } }] } },
    ],
  })}\n\n`
}

const DONE = 'data: [DONE]\n\n'

interface StreamOptions {
  /** Reject the reader after these chunks are delivered. */
  failAfter?: Error
}

function streamResponse(chunks: string[], options: StreamOptions = {}): Response {
  let next = 0
  // `pull` (not `start`) so the queued frames are actually DELIVERED before
  // the failure: `controller.error` in `start` would discard the queue, which
  // is not what a connection cut mid-frame looks like.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) {
        controller.enqueue(encoder.encode(chunks[next]))
        next += 1
        return
      }
      if (options.failAfter) controller.error(options.failAfter)
      else controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function httpError(status: number): Response {
  return new Response(JSON.stringify({ error: { message: 'boom' } }), { status })
}

/**
 * A 200 response that emits `chunks`, then never settles — a connection that
 * went silent without closing. Aborting `signal` errors the body the way a real
 * `fetch` does, which is exactly what the idle watchdog relies on.
 */
function stalledResponse(chunks: string[], signal: AbortSignal | null | undefined): Response {
  let next = 0
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController
    },
    pull(streamController) {
      if (next >= chunks.length) return
      streamController.enqueue(encoder.encode(chunks[next]))
      next += 1
    },
  })
  if (signal) {
    const attemptSignal = signal
    attemptSignal.addEventListener('abort', () => controller?.error(attemptSignal.reason), {
      once: true,
    })
  }
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** Emits each chunk after its own delay; the gaps drive the idle clock. */
function pacedResponse(chunks: { delayMs: number; text: string }[]): Response {
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index]
      if (!chunk) {
        controller.close()
        return
      }
      index += 1
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          controller.enqueue(encoder.encode(chunk.text))
          resolve()
        }, chunk.delayMs)
      })
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const request = {
  apiKey: 'k',
  baseUrl: 'https://api.example.com/v1',
  model: 'm',
  messages: [{ role: 'user' as const, content: 'hi' }],
}

/** The JSON body the stubbed fetch received on call `index` (0-based). */
function sentBody(fetchMock: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const call = fetchMock.mock.calls[index] as [string, RequestInit]
  return JSON.parse(call[1].body as string) as Record<string, unknown>
}

describe('streamCompletion continuation retry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('resends the same request when nothing was streamed yet', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(httpError(502))
      .mockResolvedValueOnce(streamResponse([textFrame('recovered'), DONE]))
    vi.stubGlobal('fetch', fetchMock)

    const retries: StreamRetryInfo[] = []
    const result = await streamCompletion(
      { ...request, retry: { retries: 3, delayMs: 0 } },
      { onRetry: (info) => retries.push(info) },
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sentBody(fetchMock, 1).messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(result.content).toBe('recovered')
    expect(retries).toHaveLength(1)
    expect(retries[0]).toMatchObject({ retry: 1, retries: 3, continuing: false })
  })

  it('continues a partially streamed reply instead of replaying it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        streamResponse([textFrame('Hello ')], { failAfter: new TypeError('network died') }),
      )
      .mockResolvedValueOnce(streamResponse([textFrame('world'), DONE]))
    vi.stubGlobal('fetch', fetchMock)

    const deltas: string[] = []
    const retries: StreamRetryInfo[] = []
    const result = await streamCompletion(
      { ...request, retry: { retries: 3, delayMs: 0 } },
      { onText: (delta) => deltas.push(delta), onRetry: (info) => retries.push(info) },
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const messages = sentBody(fetchMock, 1).messages as Array<Record<string, unknown>>
    expect(messages).toHaveLength(3)
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Hello ' })
    expect(messages[2]?.role).toBe('user')
    expect(String(messages[2]?.content)).toContain('Continue')
    expect(result.content).toBe('Hello world')
    expect(deltas.join('')).toBe('Hello world')
    expect(retries[0]).toMatchObject({ retry: 1, retries: 3, continuing: true })
  })

  it('does not retry after a tool call was announced', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        streamResponse([toolFrame('click')], { failAfter: new TypeError('cut') }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      streamCompletion({ ...request, retry: { retries: 3, delayMs: 0 } }),
    ).rejects.toBeInstanceOf(LlmError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('continues when the provider reports an error frame mid-stream', async () => {
    const errorFrame = `data: ${JSON.stringify({ error: { message: 'overloaded' } })}\n\n`
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse([textFrame('half '), errorFrame]))
      .mockResolvedValueOnce(streamResponse([textFrame('done'), DONE]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await streamCompletion({ ...request, retry: { retries: 3, delayMs: 0 } })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.content).toBe('half done')
  })

  it('treats a clean close with neither [DONE] nor finish_reason as a cut stream', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse([textFrame('first ')]))
      .mockResolvedValueOnce(streamResponse([textFrame('second'), DONE]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await streamCompletion({ ...request, retry: { retries: 3, delayMs: 0 } })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const messages = sentBody(fetchMock, 1).messages as Array<Record<string, unknown>>
    expect(messages[1]).toEqual({ role: 'assistant', content: 'first ' })
    expect(result.content).toBe('first second')
  })

  it('does not treat [DONE]-without-finish_reason or a finish_reason as truncation', async () => {
    const finishFrame = `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
    })}\n\n`
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse([textFrame('a'), DONE]))
      .mockResolvedValueOnce(streamResponse([textFrame('b'), finishFrame]))
    vi.stubGlobal('fetch', fetchMock)

    const withDone = await streamCompletion({ ...request, retry: { retries: 3, delayMs: 0 } })
    const withFinish = await streamCompletion({ ...request, retry: { retries: 3, delayMs: 0 } })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(withDone.content).toBe('a')
    expect(withFinish.content).toBe('b')
  })

  it('reports usage for every attempt and returns the last one', async () => {
    const usageFrame = (input: number, output: number): string =>
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
      })}\n\n`
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        streamResponse([textFrame('x'), usageFrame(10, 1)], { failAfter: new TypeError('cut') }),
      )
      .mockResolvedValueOnce(streamResponse([textFrame('y'), usageFrame(20, 2), DONE]))
    vi.stubGlobal('fetch', fetchMock)

    const reported: number[] = []
    const result = await streamCompletion(
      { ...request, retry: { retries: 3, delayMs: 0 } },
      { onUsage: (usage) => reported.push(usage.inputTokens) },
    )

    expect(reported).toEqual([10, 20])
    expect(result.usage?.inputTokens).toBe(20)
  })

  it('waits the fixed delay and spends the caller’s budget (10 × 5s)', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue(httpError(500))
    vi.stubGlobal('fetch', fetchMock)

    const retries: StreamRetryInfo[] = []
    const settled = streamCompletion(
      { ...request, retry: { retries: 10, delayMs: 5_000 } },
      { onRetry: (info) => retries.push(info) },
    ).catch((error: unknown) => error)

    for (let index = 0; index < 10; index += 1) {
      await vi.advanceTimersByTimeAsync(5_000)
    }
    const error = await settled

    expect(error).toBeInstanceOf(LlmError)
    expect(fetchMock).toHaveBeenCalledTimes(11)
    expect(retries).toHaveLength(10)
    expect(retries.map((info) => info.retry)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(retries.every((info) => info.delayMs === 5_000 && info.retries === 10)).toBe(true)
  })

  it('keeps mid-stream failures terminal when no policy is passed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        streamResponse([textFrame('half')], { failAfter: new TypeError('cut') }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(streamCompletion(request)).rejects.toBeInstanceOf(LlmError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops retrying when the request is aborted during the wait', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue(httpError(500))
    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    const settled = streamCompletion({
      ...request,
      retry: { retries: 10, delayMs: 5_000 },
      signal: controller.signal,
    }).catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await vi.advanceTimersByTimeAsync(5_000)
    const error = await settled

    expect((error as Error).name).toBe('AbortError')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('streamCompletion idle watchdog', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('cuts a silent connection after idleTimeoutMs and continues the reply', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init: RequestInit) =>
        Promise.resolve(stalledResponse([textFrame('Hello ')], init.signal)),
      )
      .mockImplementationOnce(() => Promise.resolve(streamResponse([textFrame('world'), DONE])))
    vi.stubGlobal('fetch', fetchMock)

    const retries: StreamRetryInfo[] = []
    const settled = streamCompletion(
      { ...request, idleTimeoutMs: 120_000, retry: { retries: 10, delayMs: 10_000 } },
      { onRetry: (info) => retries.push(info) },
    )

    await vi.advanceTimersByTimeAsync(0)
    // A total cap would already have killed this call; silence is what counts.
    await vi.advanceTimersByTimeAsync(119_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await settled

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const messages = sentBody(fetchMock, 1).messages as Array<Record<string, unknown>>
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Hello ' })
    expect(result.content).toBe('Hello world')
    expect(retries).toHaveLength(1)
    expect(retries[0]).toMatchObject({ retry: 1, retries: 10, delayMs: 10_000, continuing: true })
    expect(retries[0]?.message).toContain('stopped sending output')
  })

  it('never cuts a reply that keeps emitting deltas, however long it runs', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValueOnce(
      pacedResponse([
        { delayMs: 100_000, text: textFrame('a') },
        { delayMs: 100_000, text: textFrame('b') },
        { delayMs: 100_000, text: textFrame('c') },
        { delayMs: 0, text: DONE },
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const settled = streamCompletion({
      ...request,
      idleTimeoutMs: 120_000,
      retry: { retries: 10, delayMs: 10_000 },
    })
    await vi.advanceTimersByTimeAsync(300_000)
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await settled

    // 300s total — far past the 120s window — yet no gap ever reached it.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.content).toBe('abc')
  })

  it('reports an exhausted idle budget as a stall, not an unreachable endpoint', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockImplementation((_url: string, init: RequestInit) =>
        Promise.resolve(stalledResponse([], init.signal)),
      )
    vi.stubGlobal('fetch', fetchMock)

    const settled = streamCompletion({
      ...request,
      idleTimeoutMs: 120_000,
      retry: { retries: 0, delayMs: 10_000 },
    }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(120_000)
    const error = await settled

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).transient).toBe(true)
    expect((error as Error).message).toContain('stopped sending output')
    expect((error as Error).message).not.toContain('Cannot reach')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('streamCompletion length continuation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('finishes an answer the provider cut at its output cap', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse([textFrame('Hello '), LENGTH_FRAME, DONE]))
      .mockResolvedValueOnce(streamResponse([textFrame('world'), STOP_FRAME, DONE]))
    vi.stubGlobal('fetch', fetchMock)

    const deltas: string[] = []
    const continuations: StreamContinueInfo[] = []
    const result = await streamCompletion(
      { ...request, retry: { retries: 3, delayMs: 0 }, continueOnLength: 2 },
      { onText: (delta) => deltas.push(delta), onContinue: (info) => continuations.push(info) },
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const messages = sentBody(fetchMock, 1).messages as Array<Record<string, unknown>>
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Hello ' })
    expect(String(messages[2]?.content)).toContain('Continue')
    expect(result.content).toBe('Hello world')
    // Nothing is replayed to the panel: the continuation only streams the rest.
    expect(deltas.join('')).toBe('Hello world')
    expect(result.finishReason).toBe('stop')
    expect(continuations).toEqual([{ continuation: 1, continuations: 2 }])
  })

  it('stops after the caller’s continuation budget and reports the cap', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse([textFrame('a'), LENGTH_FRAME, DONE]))
      .mockResolvedValueOnce(streamResponse([textFrame('b'), LENGTH_FRAME, DONE]))
    vi.stubGlobal('fetch', fetchMock)

    const continuations: StreamContinueInfo[] = []
    const result = await streamCompletion(
      { ...request, retry: { retries: 3, delayMs: 0 }, continueOnLength: 1 },
      { onContinue: (info) => continuations.push(info) },
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.content).toBe('ab')
    // The host reads this as "still cut" and tells the user about the limit.
    expect(result.finishReason).toBe('length')
    expect(continuations).toHaveLength(1)
  })

  it('leaves a truncated tool call alone', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        streamResponse([textFrame('working '), toolFrame('click'), LENGTH_FRAME, DONE]),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await streamCompletion({
      ...request,
      retry: { retries: 3, delayMs: 0 },
      continueOnLength: 3,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.finishReason).toBe('length')
    expect(result.toolCalls).toHaveLength(1)
  })

  it('does not spend the retry budget on a continuation', async () => {
    // One retry allowed: a continuation that counted as an attempt would leave
    // nothing for the 502 below and the call would throw.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse([textFrame('a'), LENGTH_FRAME, DONE]))
      .mockResolvedValueOnce(httpError(502))
      .mockResolvedValueOnce(streamResponse([textFrame('b'), STOP_FRAME, DONE]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await streamCompletion(
      { ...request, retry: { retries: 1, delayMs: 0 }, continueOnLength: 1 },
      {},
    )

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.content).toBe('ab')
    expect(result.finishReason).toBe('stop')
  })

  it('returns the truncated answer untouched when the caller opts out', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse([textFrame('half'), LENGTH_FRAME, DONE]))
    vi.stubGlobal('fetch', fetchMock)

    const result = await streamCompletion({ ...request, retry: { retries: 3, delayMs: 0 } })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.content).toBe('half')
    expect(result.finishReason).toBe('length')
  })
})
