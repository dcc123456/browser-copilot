/**
 * Compaction must not rewrite the transcript storage persists (AC-5⑤).
 *
 * Ported from QA's `tmp/qa-ac14-compaction.spec.ts`. The provider rejects one
 * request with a 32k limit so the reactive path really runs; the assertions
 * then pin both sides: compaction happened (summarizer called, notice shown)
 * and the stored history is byte-for-byte what it was before the turn.
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
  text: 'Item detail page.',
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
let rejectAtRound = -1
let summarizerCalls = 0
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
  rejectAtRound = -1
  summarizerCalls = 0
  snapshotMock.mockReset()
  execMock.mockReset()
  streamMock.mockReset()
  snapshotMock.mockResolvedValue(PAGE)
  execMock.mockResolvedValue({ ok: true, data: {} })
  streamMock.mockImplementation((async (
    call: { messages: WireMessage[]; tools?: unknown[] },
    handlers: { onUsage?: (usage: unknown) => void },
  ) => {
    if (isSummarizer(call)) {
      summarizerCalls += 1
      const usage = { inputTokens: 500, outputTokens: 60, cachedInputTokens: 0, totalTokens: 560 }
      handlers?.onUsage?.(usage)
      return {
        content: 'summary: the user is reading the item page and has not finished',
        reasoning: '',
        toolCalls: [],
        finishReason: 'stop',
        usage,
      } as StreamResult
    }
    if (round === rejectAtRound) {
      round += 1
      throw new LlmError(
        "This model's maximum context length is 32768 tokens, however your messages resulted in 40000 tokens.",
        { status: 400 },
      )
    }
    const usage = { inputTokens: 4_200, outputTokens: 30, cachedInputTokens: 0, totalTokens: 4_230 }
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

function seededHistory(): WireMessage[] {
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
        text: `turn ${turn + 1} price: ${100 + turn}`,
      }),
    })
  }
  history.push({ role: 'user', content: 'keep reading the price' })
  return history
}

function toolPairingProblem(messages: readonly WireMessage[]): string {
  const calls = new Set<string>()
  for (const message of messages) {
    const record = message as {
      role?: string
      tool_calls?: { id?: string }[]
      tool_call_id?: string
    }
    if (record.role === 'assistant') {
      for (const call of record.tool_calls ?? []) if (call.id) calls.add(call.id)
    }
    if (record.role === 'tool' && record.tool_call_id && !calls.has(record.tool_call_id)) {
      return `orphan tool result ${record.tool_call_id}`
    }
  }
  return 'none'
}

describe('compaction persistence boundary', () => {
  it('runs the forced compaction and leaves the stored transcript untouched', async () => {
    const history = seededHistory()
    const before = structuredClone(history) as WireMessage[]
    const statuses: string[] = []
    rejectAtRound = 3

    await runAgentTurn(
      history as never,
      {
        send: (message: { type: string; text?: string }) => {
          if (message.type === 'status' && message.text) statuses.push(message.text)
        },
        confirm: async () => true,
        conversationId: `ac14-${Date.now()}`,
        getMode: async () => 'full' as const,
        getMaxRoundsBeforeStop: async () => 8,
        getToolConfig: async () => ({ disabledTools: [], basePrompt: '' }),
      } as never,
    )

    // The path executed: one summarizer call and the user was told about it.
    expect(summarizerCalls).toBe(1)
    expect(statuses.some((text) => text.toLowerCase().includes('summarized'))).toBe(true)
    // Storage-facing invariants.
    expect(JSON.stringify(history)).not.toContain('[Context compacted]')
    expect(JSON.stringify(history)).not.toContain('"retired":true')
    const survivingSeed = before.filter(
      (message, index) => JSON.stringify(message) === JSON.stringify(history[index]),
    )
    expect(survivingSeed).toHaveLength(before.length)
    expect(JSON.stringify(history)).toContain(JSON.stringify(before[1]))
    expect(
      history.filter(
        (message) =>
          message.role === 'user' && String(message.content).includes('[Context compacted]'),
      ),
    ).toHaveLength(0)
    expect(toolPairingProblem(history)).toBe('none')
  }, 60_000)

  it('does not announce a compaction that removed nothing', async () => {
    // A single-turn history has nothing compactable; the provider still
    // rejects. Saying "summarized" here is the false notice QA caught.
    const history: WireMessage[] = [{ role: 'user', content: 'read the page' }]
    const statuses: string[] = []
    rejectAtRound = 0
    await runAgentTurn(
      history as never,
      {
        send: (message: { type: string; text?: string }) => {
          if (message.type === 'status' && message.text) statuses.push(message.text)
        },
        confirm: async () => true,
        conversationId: `ac14-empty-${Date.now()}`,
        getMode: async () => 'full' as const,
        getMaxRoundsBeforeStop: async () => 4,
        getToolConfig: async () => ({ disabledTools: [], basePrompt: '' }),
      } as never,
    )

    expect(statuses.some((text) => text.toLowerCase().includes('summarized'))).toBe(false)
  }, 60_000)
})
