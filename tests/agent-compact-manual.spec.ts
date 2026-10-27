import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { compactConversationOnRequest } from '../src/background/agent'
import { streamCompletion, type WireMessage } from '../src/lib/llm'
import { effectiveLocale, messagesFor } from '../src/lib/i18n'

/**
 * Manual compaction (the panel's "compress context" action) has to be the SAME
 * operation the automatic trigger performs — same summarizer request, same
 * marker, same recent turns kept verbatim — and it must refuse to rewrite a
 * transcript it cannot summarise for real.
 */

vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: vi.fn() }
})

const getActiveProviderMock = vi.fn()
const getSettingsMock = vi.fn()
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return {
    ...actual,
    getActiveProvider: (...args: unknown[]) => getActiveProviderMock(...args),
    getSettings: (...args: unknown[]) => getSettingsMock(...args),
  }
})

const streamMock = vi.mocked(streamCompletion)
const PROVIDER = { apiKey: 'k', baseUrl: 'https://x', model: 'm', label: 'test' }
/** The summarizer request is the only one whose system prompt starts this way. */
const SUMMARIZER_MARK = 'You compress the earlier part'

function conversation(): WireMessage[] {
  return [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'answer one' },
    { role: 'tool', tool_call_id: 't1', content: 'page read result' },
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: 'answer two' },
    { role: 'user', content: 'third question' },
    { role: 'assistant', content: 'answer three' },
    { role: 'user', content: 'fourth question' },
  ]
}

function texts(messages: WireMessage[]): string[] {
  return messages.map((m) => (typeof m.content === 'string' ? m.content : ''))
}

beforeEach(() => {
  getActiveProviderMock.mockResolvedValue(PROVIDER)
  getSettingsMock.mockResolvedValue({ locale: 'en' })
  streamMock.mockResolvedValue({
    content: 'COMPACTED SUMMARY',
    reasoning: '',
    toolCalls: [],
    finishReason: 'stop',
    usage: null,
  })
})

afterEach(() => {
  streamMock.mockReset()
  getActiveProviderMock.mockReset()
  getSettingsMock.mockReset()
})

describe('compactConversationOnRequest', () => {
  it('compacts the older turns and keeps every user turn verbatim', async () => {
    const history = conversation()
    const outcome = await compactConversationOnRequest(history, 'conv-manual')

    // Four turns, the two most recent stay untouched, so turn one and two lose
    // their assistant/tool messages to one summary.
    expect(outcome?.removed).toBe(3)
    for (const kept of ['first question', 'second question', 'third question', 'fourth question']) {
      expect(texts(history)).toContain(kept)
    }
    expect(texts(history)).not.toContain('answer one')
    expect(texts(history)).not.toContain('answer two')
    expect(texts(history)).toContain('answer three')

    const marker = messagesFor(effectiveLocale('en', 'en')).contextCompactedMarker
    const summary = history.find((m) => texts([m]).some((text) => text.startsWith(marker)))
    expect(summary?.role).toBe('user')
    expect(summary?.content).toContain('COMPACTED SUMMARY')
    // Inserted where the first removal happened, i.e. right after the oldest user turn.
    expect(history.indexOf(summary as WireMessage)).toBe(1)
  })

  it('asks the same summarizer the automatic path asks', async () => {
    await compactConversationOnRequest(conversation(), 'conv-manual')
    const request = streamMock.mock.calls[0]?.[0] as unknown as
      | { messages: WireMessage[]; maxTokens?: number; tools?: unknown; temperature?: number }
      | undefined
    expect(request?.messages[0]?.content).toContain(SUMMARIZER_MARK)
    expect(request?.messages).toHaveLength(2)
    expect(request?.tools).toBeUndefined()
    expect(request?.maxTokens).toBe(1_024)
    expect(request?.temperature).toBe(0)
  })

  it('refuses to rewrite the transcript without a provider', async () => {
    getActiveProviderMock.mockRejectedValue(new Error('No model provider configured.'))
    const history = conversation()
    await expect(compactConversationOnRequest(history, 'conv-noprovider')).rejects.toThrow(
      'No model provider configured.',
    )
    // No digest fallback, no dropped messages: the transcript is exactly as it was.
    expect(history).toEqual(conversation())
    expect(streamMock).not.toHaveBeenCalled()
  })

  it('reports nothing to compact when the recent turns cover the whole chat', async () => {
    const history: WireMessage[] = [
      { role: 'user', content: 'only question' },
      { role: 'assistant', content: 'only answer' },
      { role: 'user', content: 'second question' },
    ]
    expect(await compactConversationOnRequest(history, 'conv-short')).toBeNull()
    expect(streamMock).not.toHaveBeenCalled()
    expect(texts(history)).toEqual(['only question', 'only answer', 'second question'])
  })
})
