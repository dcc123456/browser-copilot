/**
 * The editor assistant's model call and the thinking effort.
 *
 * The assistant runs through the same `streamCompletion` the side panel uses, so
 * the level must reach the request body — and it must reach it *silently
 * skipped* when the model cannot express it, which is the gap this pins down.
 * The model's thinking must also survive the call: the editor shows it live
 * while the answer is written, and the turn keeps it afterwards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const provider = {
  id: 'p1',
  name: 'qwen',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: 'k',
  model: 'qwen3-max',
  models: ['qwen3-max'],
  thinkingEffort: 'high' as string | undefined,
}

vi.mock('../src/lib/storage', () => ({
  getSettings: vi.fn(async () => ({ providers: [provider], activeProviderId: 'p1' })),
}))

const { runOperatorAdvise } = await import('../src/background/operator-advise-engine')

/** A successful SSE response carrying one text delta and the terminator. */
function sseResponse(text = '{"reply":"ok","proposals":[]}'): Response {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** A successful SSE response whose deltas carry the model's thinking. */
function sseWithReasoning(reasoning: string, text: string): Response {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('')
  return new Response(frames, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** The JSON body of the fetch call the assistant made. */
function bodyOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

const input = {
  sessionId: 's1',
  messages: [{ role: 'user' as const, content: '打开 https://www.baidu.com' }],
  graphDigest: '1. trigger',
}

/** Runs the assistant on the default (no injected model call) path. */
async function advise() {
  return runOperatorAdvise(input, {
    signal: new AbortController().signal,
    readPage: async () => null,
  })
}

describe('the editor assistant and thinking effort', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    provider.baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    provider.model = 'qwen3-max'
    provider.thinkingEffort = 'high'
  })

  it('sends the configured level to the vendor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse())
    vi.stubGlobal('fetch', fetchMock)

    await advise()

    expect(bodyOf(fetchMock)).toMatchObject({ enable_thinking: true, thinking_budget: 32768 })
  })

  it('sends nothing when the model is documented to reject thinking control', async () => {
    provider.baseUrl = 'https://api.openai.com/v1'
    provider.model = 'gpt-4o-mini'
    const fetchMock = vi.fn().mockResolvedValue(sseResponse())
    vi.stubGlobal('fetch', fetchMock)

    await advise()

    const body = bodyOf(fetchMock)
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.enable_thinking).toBeUndefined()
  })

  it('keeps the thinking the model produced', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseWithReasoning('let me pick an operator', '{"reply":"ok","proposals":[]}'),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await advise()

    expect(result.reasoning).toBe('let me pick an operator')
  })

  it('reports the model whose thinking level could not be sent', async () => {
    provider.baseUrl = 'https://api.openai.com/v1'
    provider.model = 'gpt-4o-mini'
    const fetchMock = vi.fn().mockResolvedValue(sseResponse())
    vi.stubGlobal('fetch', fetchMock)

    const result = await advise()

    expect(result.thinkingSkippedModel).toBe('gpt-4o-mini')
  })

  it('says nothing about a skipped level when none is configured', async () => {
    provider.thinkingEffort = undefined
    const fetchMock = vi.fn().mockResolvedValue(sseResponse())
    vi.stubGlobal('fetch', fetchMock)

    const result = await advise()

    expect(result.thinkingSkippedModel).toBeUndefined()
    expect(result.reasoning).toBeUndefined()
  })
})
