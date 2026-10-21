/**
 * Chat-turn integration for the two stream-resilience behaviors:
 * the reconnect policy the transport is asked for, the visible status line it
 * produces, and the session-summary `<details>` block being removed from BOTH
 * the streamed deltas and the history the next round reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentServerMessage } from '../src/lib/messages'
import { runAgentTurn } from '../src/background/agent'
import { streamCompletion } from '../src/lib/llm'

vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: vi.fn() }
})

const getActiveProviderMock = vi.fn()
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return { ...actual, getActiveProvider: (...args: unknown[]) => getActiveProviderMock(...args) }
})

beforeEach(() => {
  getActiveProviderMock.mockResolvedValue({
    apiKey: 'k',
    baseUrl: 'https://x',
    model: 'm',
    label: 'test',
  })
})

const streamMock = vi.mocked(streamCompletion)

afterEach(() => {
  streamMock.mockReset()
})

function deps(send: (message: AgentServerMessage) => void) {
  return {
    send,
    confirm: vi.fn(async () => true),
    askUser: vi.fn(async () => ({ answer: '', cancelled: true })),
    conversationId: `conv-${Math.random().toString(36).slice(2)}`,
    getMode: async () => 'semi' as const,
    getMaxToolRounds: async () => 4,
    getToolConfig: async () => ({ disabledTools: [] as string[], basePrompt: '' }),
  }
}

const SUMMARY =
  '<details>\n<summary>Summary</summary>\nThe user asked to clear drafts, the assistant did it.\n</details>'

describe('chat stream resilience wiring', () => {
  it('asks the transport for ten reconnects five seconds apart', async () => {
    streamMock.mockResolvedValue({ content: 'ok', toolCalls: [] } as never)

    await runAgentTurn([{ role: 'user', content: 'hi' }] as never, deps(() => {}) as never)

    expect(streamMock.mock.calls[0]?.[0]).toMatchObject({
      retry: { retries: 10, delayMs: 5_000 },
    })
  })

  it('surfaces a reconnect status line from the retry hook', async () => {
    streamMock.mockImplementation((async (
      _request: unknown,
      handlers: { onRetry?: (info: unknown) => void },
    ) => {
      handlers.onRetry?.({
        retry: 2,
        retries: 10,
        delayMs: 5_000,
        continuing: true,
        message: 'cut',
      })
      return { content: 'ok', toolCalls: [] }
    }) as never)

    const sent: AgentServerMessage[] = []
    await runAgentTurn(
      [{ role: 'user', content: 'hi' }] as never,
      deps((message) => sent.push(message)) as never,
    )

    const status = sent.filter((message) => message.type === 'status')
    expect(
      status.some((message) => message.text.includes('2/10') && message.text.includes('5s')),
    ).toBe(true)
  })

  it('removes a summary block from the streamed reply and the saved history', async () => {
    const answer = `The drafts are cleared.\n\n${SUMMARY}`
    streamMock.mockImplementation((async (
      _request: unknown,
      handlers: { onText?: (delta: string) => void },
    ) => {
      // Delivered in pieces that split tags, as a real stream would.
      handlers.onText?.('The drafts are cleared.\n\n<det')
      handlers.onText?.(
        `ails>\n<summary>Summary</summary>\nThe user asked to clear drafts, the assistant did it.\n</det`,
      )
      handlers.onText?.('ails>')
      return { content: answer, toolCalls: [] }
    }) as never)

    const history = [{ role: 'user', content: 'clear my drafts' }]
    const sent: AgentServerMessage[] = []
    await runAgentTurn(history as never, deps((message) => sent.push(message)) as never)

    const visible = sent
      .filter((message): message is Extract<AgentServerMessage, { type: 'delta' }> => {
        return message.type === 'delta'
      })
      .map((message) => message.text)
      .join('')
    expect(visible).toBe('The drafts are cleared.\n\n')
    expect(history[1]).toMatchObject({ role: 'assistant', content: 'The drafts are cleared.\n\n' })
  })
})
