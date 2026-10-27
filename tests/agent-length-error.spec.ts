import { afterEach, describe, expect, it, vi } from 'vitest'

import { inputLimitFromError, runAgentTurn } from '../src/background/agent'
import { LlmError, streamCompletion, type WireMessage } from '../src/lib/llm'

describe('reactive compaction parses the provider limit', () => {
  it('reads the DashScope 400 input-length bound', () => {
    const message =
      '阿里云百炼 DashScope request failed (400 ): data: {"error":{"code":"invalid_parameter_error","message":"Range of input length should be [1, 983616]"}}'
    expect(inputLimitFromError(message)).toBe(983616)
  })
  it('reads OpenAI-style maximum context length errors', () => {
    expect(inputLimitFromError('maximum context length is 128000 tokens')).toBe(128000)
  })
  it('returns undefined for unrelated errors', () => {
    expect(inputLimitFromError('invalid api key')).toBeUndefined()
  })
})

/**
 * The learned window. A provider's over-length 400 is the only first-hand fact
 * about the model's real context size, so it is remembered per conversation:
 * from the next turn on, compaction triggers at 90% of THAT window, before the
 * request can 400 again. Otherwise the threshold is 90% of the assumed 256K,
 * which a small-window model never reaches — the symptom being "it only ever
 * fails, never compacts".
 */
vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: vi.fn() }
})

const getActiveProviderMock = vi.fn()
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return { ...actual, getActiveProvider: (...args: unknown[]) => getActiveProviderMock(...args) }
})

const streamMock = vi.mocked(streamCompletion)

/** The summarizer request is the only one whose system prompt starts this way. */
const SUMMARIZER_MARK = 'You compress the earlier part'

const PROVIDER = { apiKey: 'k', baseUrl: 'https://x', model: 'm', label: 'test' }

function deps(conversationId: string) {
  return {
    send: () => {},
    confirm: vi.fn(async () => true),
    conversationId,
    getMode: async () => 'chat' as const,
    getMaxToolRounds: async () => 2,
    getToolConfig: async () => ({ disabledTools: [] as string[], basePrompt: '' }),
  }
}

/**
 * Which conversation a request belongs to, read off its transcript: compaction
 * never removes a user turn, so the first one survives every path.
 */
function transcriptKey(messages: WireMessage[]): string {
  const first = messages.find((m) => m.role === 'user')
  return typeof first?.content === 'string' ? first.content.slice(0, 12) : ''
}

function turn(kind: string): WireMessage[] {
  // ~8,400 estimated tokens of answers: under 90% of the assumed 256K window,
  // over 90% of the 8,000-token bound these tests make the provider state.
  const chunk = 'x'.repeat(6_000)
  return [
    { role: 'user', content: `${kind}-goal` },
    { role: 'assistant', content: chunk },
    { role: 'user', content: `${kind}-next` },
    { role: 'assistant', content: chunk },
    { role: 'user', content: `${kind}-then` },
    { role: 'assistant', content: chunk },
    { role: 'user', content: `${kind}-and` },
    { role: 'assistant', content: chunk },
    { role: 'user', content: `${kind}-now` },
  ]
}

function totalChars(messages: WireMessage[]): number {
  return messages.reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
    0,
  )
}

/** How many of the planted 6,000-character answers are still in the request. */
function plantedAnswers(messages: WireMessage[]): number {
  return messages.filter((m) => typeof m.content === 'string' && m.content.length > 1_000).length
}

/**
 * Records the transcript of every turn request (summarizer calls excluded) by
 * conversation key, and rejects the first request of `rejectFirstOf` with the
 * provider's stated bound.
 */
function recordRequests(rejectFirstOf?: string): Map<string, WireMessage[][]> {
  const byKey = new Map<string, WireMessage[][]>()
  const seen = new Map<string, number>()
  streamMock.mockImplementation(async (request: { messages: WireMessage[] }) => {
    const first = request.messages[0]
    if (typeof first?.content === 'string' && first.content.startsWith(SUMMARIZER_MARK)) {
      return {
        content: 'SUMMARY',
        reasoning: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: null,
      }
    }
    const key = transcriptKey(request.messages)
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    const list = byKey.get(key) ?? []
    list.push(request.messages)
    byKey.set(key, list)
    if (rejectFirstOf === key && count === 1) {
      throw new LlmError('Range of input length should be [1, 8000]', { status: 400 })
    }
    return { content: 'ok', reasoning: '', toolCalls: [], finishReason: 'stop', usage: null }
  })
  return byKey
}

describe('the compaction window is the provider-stated one', () => {
  afterEach(() => {
    streamMock.mockReset()
    getActiveProviderMock.mockReset()
  })

  it('compacts the next turn at 90% of the stated window, without another 400', async () => {
    getActiveProviderMock.mockResolvedValue(PROVIDER)
    const learned = 'learned'
    const naive = 'naive'
    const byKey = recordRequests(`${learned}-goal`)
    const learnedConversation = `conv-${learned}`

    // Turn 1: the provider rejects the request and states its 8,000-token bound.
    await runAgentTurn(
      [
        { role: 'user', content: `${learned}-goal` },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: `${learned}-q2` },
      ],
      deps(learnedConversation) as never,
    )
    // Recovered in-turn: the rejected request was resent once, no second 400.
    expect(byKey.get(`${learned}-goal`)).toHaveLength(2)

    // Turn 2: 8,400 estimated tokens is past 90% of 8,000, so the older answers
    // are summarised BEFORE sending — the transcript goes out shortened.
    await runAgentTurn(turn(learned), deps(learnedConversation) as never)
    const compactedRequest = (byKey.get(`${learned}-goal`) ?? []).at(-1)!
    expect(plantedAnswers(compactedRequest)).toBeLessThan(plantedAnswers(turn(learned)))
    expect(totalChars(compactedRequest)).toBeLessThan(totalChars(turn(learned)))

    // Control: an identical conversation that never learned a window compares
    // against 90% of the assumed 256K, so it sends every planted answer.
    await runAgentTurn(turn(naive), deps(`conv-${naive}`) as never)
    const uncompactRequest = byKey.get(`${naive}-goal`)![0]!
    expect(plantedAnswers(uncompactRequest)).toBe(4)
  })
})
