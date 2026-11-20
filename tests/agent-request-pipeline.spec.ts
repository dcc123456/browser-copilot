/**
 * The real loop over 100 rounds (AC-16): compaction × hard cap × retirement
 * must not let the request — or the stored transcript — grow back.
 *
 * The pure-function matrix cannot catch this: the regressions lived in the
 * loop's per-round state (a reset projection, a re-compaction built from raw
 * history, a retirement that skipped hard-capped reads). This test drives
 * `runAgentTurn` itself, forces a 400 so compaction really runs, and then
 * measures 100 rounds.
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

const ROUNDS = 100
let round = 0
let summarizerCalls = 0
interface RequestMetric {
  bytes: number
  rawReads: number
  hasSummary: boolean
}
const metrics: RequestMetric[] = []
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
  metrics.length = 0
  snapshotMock.mockReset()
  execMock.mockReset()
  streamMock.mockReset()
  snapshotMock.mockResolvedValue({ ...PAGE, text: 'PRICE '.repeat(30) })
  // A CONSTANT page signature settles after two probes; an empty object never
  // equals the previous probe, so every action would poll until the 1.5s
  // timeout (100 rounds × 1.5s = the test never finishes).
  execMock.mockImplementation(async (request: { action?: string }) =>
    request.action === 'page_signature' ? { ok: true, data: 'stable' } : { ok: true, data: {} },
  )
  streamMock.mockImplementation((async (
    call: { messages: WireMessage[]; tools?: unknown[] },
    handlers: { onUsage?: (usage: unknown) => void },
  ) => {
    if (isSummarizer(call)) {
      summarizerCalls += 1
      const usage = { inputTokens: 800, outputTokens: 60, cachedInputTokens: 0, totalTokens: 860 }
      handlers?.onUsage?.(usage)
      return {
        content: 'summary: reading the item page repeatedly',
        reasoning: '',
        toolCalls: [],
        finishReason: 'stop',
        usage,
      } as StreamResult
    }
    const text = JSON.stringify(call.messages)
    metrics.push({
      bytes: text.length,
      rawReads: call.messages.filter(
        (message) =>
          message.role === 'tool' &&
          String((message as { name?: string }).name) === 'snapshot_page' &&
          !String(message.content).includes('"retired":true'),
      ).length,
      hasSummary: text.includes('[Context compacted]'),
    })
    if (round === 1) {
      round += 1
      throw new LlmError(
        "This model's maximum context length is 32768 tokens, however your messages resulted in 40000 tokens.",
        { status: 400 },
      )
    }
    const usage = { inputTokens: 3_000, outputTokens: 20, cachedInputTokens: 0, totalTokens: 3_020 }
    handlers?.onUsage?.(usage)
    round += 1
    if (round > ROUNDS) {
      return {
        content: 'done',
        reasoning: '',
        toolCalls: [],
        finishReason: 'stop',
        usage,
      } as StreamResult
    }
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
    history.push({ role: 'user', content: `turn ${turn + 1}: read it` })
    history.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: `seed-${turn}`,
          type: 'function',
          function: { name: 'snapshot_page', arguments: '{}' },
        },
      ],
    })
    history.push({
      role: 'tool',
      tool_call_id: `seed-${turn}`,
      name: 'snapshot_page',
      content: JSON.stringify({
        url: 'https://shop.test/p',
        title: 'P',
        // Large enough that the hard cap truncates the kept read once.
        text: `SEED ${turn} PRICE `.repeat(15_000),
      }),
    })
  }
  history.push({ role: 'user', content: 'keep watching the price' })
  return history
}

describe('real loop over 100 rounds', () => {
  it('keeps one raw read, bounded growth, and an untouched stored transcript', async () => {
    const history = seededHistory()
    const before = structuredClone(history) as WireMessage[]

    await runAgentTurn(
      history as never,
      {
        send: () => {},
        confirm: async () => true,
        conversationId: `pipeline-${Date.now()}`,
        getMode: async () => 'full' as const,
        getMaxToolRounds: async () => ROUNDS + 1,
        getToolConfig: async () => ({ disabledTools: [], basePrompt: '' }),
      } as never,
    )

    // The escapes really ran: a summary was paid for and a 400 was recovered.
    expect(summarizerCalls).toBeGreaterThanOrEqual(1)
    expect(metrics.some((metric) => metric.hasSummary)).toBe(true)

    // The stored transcript keeps the seed byte-for-byte and never gains a
    // stub, a compaction marker, or a truncation marker.
    const stored = JSON.stringify(history)
    expect(history.slice(0, before.length)).toEqual(before)
    expect(stored).not.toContain('"retired":true')
    expect(stored).not.toContain('[Context compacted]')
    expect(stored).not.toContain('[context-truncated]')

    // Every request keeps at most one raw page read.
    expect(Math.max(...metrics.map((metric) => metric.rawReads))).toBeLessThanOrEqual(1)

    // Per-round growth stays bounded (~390 B measured; the regressed build
    // grew ~3.5 KB/round). A ratio bound would let a 3.8x tail through.
    const sizes = metrics.map((metric) => metric.bytes)
    const deltas = sizes.slice(1).map((size, index) => size - sizes[index]!)
    const steady = deltas.slice(5)
    expect(Math.max(...steady)).toBeLessThanOrEqual(1_024)
  }, 120_000)
})
