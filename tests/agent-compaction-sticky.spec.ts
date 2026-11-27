/**
 * Compaction stickiness (AC-5⑥): a summary the turn paid for must reach every
 * later request, not only the retry that triggered it.
 *
 * Ported from QA's `tmp/qa-compaction-sticky.spec.ts`; the print-only numbers
 * are now assertions. The key case is the round AFTER the compaction: a
 * projection that is rebuilt per round loses it there.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentTurn } from '../src/background/agent'
import { LlmError, streamCompletion } from '../src/lib/llm'
import type { StreamResult, WireMessage } from '../src/lib/llm'

vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: vi.fn() }
})

const execMock = vi.fn()
const snapshotMock = vi.fn()
vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return {
    ...actual,
    execOnActiveTab: (...args: unknown[]) => execMock(...(args as [])),
    snapshotActiveTab: (...args: unknown[]) => snapshotMock(...(args as [])),
  }
})
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return {
    ...actual,
    getActiveProvider: async () => ({
      apiKey: 'k',
      baseUrl: 'https://x',
      model: 'm',
      label: 'sim',
    }),
    addHistory: async () => {},
  }
})

const PAGE = {
  url: 'https://shop.test/p',
  title: 'P',
  text: 'x',
  truncated: false,
  selection: '',
  elements: [],
  elementsTruncated: false,
  frameUrl: 'https://shop.test/p',
  isTopFrame: true,
  forms: [],
  scrollHeight: 1200,
  scrollY: 0,
  viewportHeight: 800,
}

let round = 0
let summarizerCalls = 0
const requests: WireMessage[][] = []
const streamMock = vi.mocked(streamCompletion)

function isSummarizer(call: { messages: WireMessage[]; tools?: unknown[] }): boolean {
  const system = call.messages[0]
  return (
    !call.tools &&
    typeof system?.content === 'string' &&
    system.content.includes('compress the earlier part')
  )
}

beforeEach(() => {
  round = 0
  summarizerCalls = 0
  requests.length = 0
  snapshotMock.mockReset()
  execMock.mockReset()
  streamMock.mockReset()
  snapshotMock.mockResolvedValue({ ...PAGE, text: 'Product detail. '.repeat(400) })
  execMock.mockResolvedValue({ ok: true, data: {} })
  streamMock.mockImplementation((async (
    call: { messages: WireMessage[]; tools?: unknown[] },
    handlers: { onUsage?: (usage: unknown) => void },
  ) => {
    if (isSummarizer(call)) {
      summarizerCalls += 1
      const usage = {
        inputTokens: 2_000,
        outputTokens: 50,
        cachedInputTokens: 0,
        totalTokens: 2_050,
      }
      handlers?.onUsage?.(usage)
      return {
        content: 'summary: the user keeps reading the page',
        reasoning: '',
        toolCalls: [],
        finishReason: 'stop',
        usage,
      } as StreamResult
    }
    requests.push(structuredClone(call.messages))
    if (round === 4) {
      round += 1
      throw new LlmError(
        "This model's maximum context length is 32768 tokens, however your messages resulted in 40000 tokens.",
        { status: 400 },
      )
    }
    const usage = { inputTokens: 1_000, outputTokens: 20, cachedInputTokens: 0, totalTokens: 1_020 }
    handlers?.onUsage?.(usage)
    round += 1
    return {
      content: '',
      reasoning: '',
      toolCalls: [
        {
          id: `c${round}`,
          type: 'function',
          function: { name: 'snapshot_page', arguments: '{}' },
        },
      ],
      finishReason: 'tool_calls',
      usage,
    } as StreamResult
  }) as never)
})

describe('compaction projection stickiness', () => {
  it('keeps the summary on the round after the one that triggered compaction', async () => {
    const history: WireMessage[] = []
    for (let turn = 0; turn < 4; turn += 1) {
      history.push({ role: 'user', content: `turn ${turn + 1}: read the price` })
      history.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: `old-${turn}`,
            type: 'function',
            function: { name: 'snapshot_page', arguments: '{}' },
          },
        ],
      })
      history.push({
        role: 'tool',
        tool_call_id: `old-${turn}`,
        name: 'snapshot_page',
        content: JSON.stringify({
          url: 'https://shop.test/p',
          text: `turn ${turn + 1} price `.repeat(500),
        }),
      })
    }
    history.push({ role: 'user', content: 'keep reading the price' })

    await runAgentTurn(
      history as never,
      {
        send: () => {},
        confirm: async () => true,
        conversationId: `sticky-${Date.now()}`,
        getMode: async () => 'full' as const,
        getMaxRoundsBeforeStop: async () => 8,
        getToolConfig: async () => ({ disabledTools: [], basePrompt: '' }),
      } as never,
    )

    // The compaction path really executed — otherwise this test would pass
    // without testing anything ("a trigger that never fired is not a pass").
    expect(summarizerCalls).toBeGreaterThanOrEqual(1)
    const markerAt = requests.map((messages) =>
      messages.some((message) => JSON.stringify(message).includes('[Context compacted]')),
    )
    const firstCompacted = markerAt.indexOf(true)
    expect(firstCompacted).toBeGreaterThan(-1)
    expect(markerAt[firstCompacted + 1]).toBe(true)
    // Persisted transcript must not carry the marker (AC-5⑤).
    expect(JSON.stringify(history)).not.toContain('[Context compacted]')
  }, 60_000)
})
