/**
 * Agent-loop wiring for durable task progress (spec R4).
 *
 * The pure record is covered in `task-progress.spec.ts`; here the contract is
 * that the loop (a) puts a resumed task's state in front of the model on the
 * FIRST request, and (b) folds executed steps + irreversible actions back into
 * the stored record so the next turn can read them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentTurn } from '../src/background/agent'
import type { AgentServerMessage } from '../src/lib/messages'
import { LlmError, streamCompletion } from '../src/lib/llm'
import type { TaskProgress } from '../src/lib/task-progress'

vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: vi.fn() }
})

const PAGE = {
  url: 'https://forms.test/checkout',
  title: 'Checkout',
  text: 'Confirm your order.',
  truncated: false,
  selection: '',
  elements: [
    {
      ref: 'e1',
      role: 'button',
      name: 'Pay now',
      tag: 'button',
      inViewport: true,
      target: { primary: { how: 'css' as const, value: '#submit' }, fallbacks: [] },
    },
  ],
  elementsTruncated: false,
  frameUrl: 'https://forms.test/checkout',
  isTopFrame: true,
  forms: [],
  scrollHeight: 800,
  scrollY: 0,
  viewportHeight: 800,
}

const execMock = vi.fn(async (_request: { action?: string }) => ({ ok: true, data: {} }))
const snapshotMock = vi.fn(async () => PAGE)
vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return {
    ...actual,
    execOnActiveTab: (request: { action?: string }) => execMock(request),
    snapshotActiveTab: (...args: unknown[]) => snapshotMock(...(args as [])),
  }
})

const loadMock = vi.fn(
  async (_conversationId: string): Promise<TaskProgress | undefined> => undefined,
)
const saveMock = vi.fn(async (_progress: TaskProgress) => {})
const costMock = vi.fn(async (_conversationId: string, _since: number) => ({
  inputTokens: 1200,
  cachedInputTokens: 900,
  outputTokens: 40,
  requests: 2,
}))
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return {
    ...actual,
    getActiveProvider: async () => ({ apiKey: 'k', baseUrl: 'https://x', model: 'm', label: 't' }),
    addHistory: async () => {},
    loadTaskProgress: (conversationId: string) => loadMock(conversationId),
    saveTaskProgress: (progress: TaskProgress) => saveMock(progress),
    taskCostSince: (conversationId: string, since: number) => costMock(conversationId, since),
  }
})

const streamMock = vi.mocked(streamCompletion)

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }
}

function deps(conversationId: string) {
  return {
    send: (_message: AgentServerMessage): void => {},
    confirm: async () => true,
    conversationId,
    getMode: async () => 'full' as const,
    getMaxToolRounds: async () => 6,
    getToolConfig: async () => ({ disabledTools: [] as string[], basePrompt: '' }),
  }
}

beforeEach(() => {
  snapshotMock.mockResolvedValue(PAGE)
  loadMock.mockReset()
  loadMock.mockResolvedValue(undefined)
  saveMock.mockReset()
  costMock.mockClear()
  execMock.mockClear()
  snapshotMock.mockClear()
  streamMock.mockReset()
})

describe('durable task progress in the agent loop', () => {
  it('puts a resumed task state in front of the model on the first request', async () => {
    loadMock.mockResolvedValue({
      version: 2,
      conversationId: 'conv-resume',
      goal: {
        summary: 'Submit the order for order 42',
        startedAt: 1000,
        maxRounds: 20,
        roundsStarted: 0,
        status: 'active',
        budgetLog: [],
      },
      steps: [{ at: 2000, tool: 'click', summary: 'Click Pay now', ok: true }],
      destructiveOps: [],
      updatedAt: 2000,
    })
    streamMock.mockResolvedValueOnce({
      content: 'continued',
      reasoning: '',
      toolCalls: [],
      finishReason: 'stop',
      usage: null,
    } as never)

    await runAgentTurn(
      [{ role: 'user', content: 'continue' }] as never,
      deps('conv-resume') as never,
    )

    const firstRequest = streamMock.mock.calls[0]?.[0] as { messages: { content: string }[] }
    const system = firstRequest.messages[0]?.content ?? ''
    expect(system).toContain('RESUMED TASK')
    expect(system).toContain('Submit the order for order 42')
    expect(system).toContain('Click Pay now')
    expect(system).toContain('1200 input')
    expect(costMock).toHaveBeenCalledWith('conv-resume', 1000)
  })

  it('keeps the compaction summary in every later request and never rewrites history', async () => {
    const seeded = [
      { role: 'user', content: 'turn 1: read the pricing page' },
      { role: 'assistant', content: 'pricing is 10 yuan' },
      { role: 'user', content: 'turn 2: add it to the cart' },
      { role: 'assistant', content: 'added' },
      { role: 'user', content: 'turn 3: compare plans' },
      { role: 'assistant', content: 'plan A is cheaper' },
      { role: 'user', content: 'turn 4: summarise' },
      { role: 'assistant', content: 'summary so far' },
      { role: 'user', content: 'turn 5: continue' },
    ] as { role: string; content: string }[]
    const seededSnapshot = JSON.parse(JSON.stringify(seeded)) as typeof seeded

    streamMock
      .mockRejectedValueOnce(
        new LlmError('maximum context length is 32768 tokens', { status: 400 }),
      )
      .mockResolvedValueOnce({
        content: 'COMPACTED SUMMARY',
        reasoning: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: null,
      } as never)
      .mockResolvedValueOnce({
        content: '',
        reasoning: '',
        toolCalls: [toolCall('c1', 'snapshot_page', {})],
        finishReason: 'tool_calls',
        usage: null,
      } as never)
      .mockResolvedValueOnce({
        content: 'continued',
        reasoning: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: null,
      } as never)

    await runAgentTurn(seeded as never, deps('conv-compact') as never)

    const retried = streamMock.mock.calls.at(-1)?.[0] as {
      messages: { role: string; content: string }[]
    }
    // The last request of the turn (after a tool round) still carries it. The
    // earlier bug reset the projection every round, so only the first retry
    // would have seen the summary.
    // The compaction the turn paid for actually reached the retried request,
    // and stays there (sticky) instead of being reset on the next round.
    expect(retried.messages.some((message) => message.content.includes('COMPACTED SUMMARY'))).toBe(
      true,
    )
    // Storage-facing transcript: no summary marker, original text intact.
    expect(seeded.slice(0, seededSnapshot.length)).toEqual(seededSnapshot)
  })

  it('blocks a repeated submit-shaped click even when the risk vocabulary misses it', async () => {
    snapshotMock.mockResolvedValue({
      ...PAGE,
      elements: [
        {
          ref: 'e1',
          role: 'button',
          name: '提交',
          tag: 'button',
          inViewport: true,
          target: { primary: { how: 'css' as const, value: '#submit' }, fallbacks: [] },
        },
      ],
    })
    streamMock
      .mockResolvedValueOnce({
        content: '',
        reasoning: '',
        toolCalls: [toolCall('c1', 'snapshot_page', {})],
        finishReason: 'tool_calls',
        usage: null,
      } as never)
      .mockResolvedValueOnce({
        content: '',
        reasoning: '',
        toolCalls: [toolCall('c2', 'click', { ref: 'e1' })],
        finishReason: 'tool_calls',
        usage: null,
      } as never)
      .mockResolvedValueOnce({
        content: '',
        reasoning: '',
        toolCalls: [toolCall('c3', 'click', { ref: 'e1' })],
        finishReason: 'tool_calls',
        usage: null,
      } as never)
      .mockResolvedValueOnce({
        content: 'done',
        reasoning: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: null,
      } as never)

    const history: { role: string; content: string }[] = [
      { role: 'user', content: '帮我开通年度会员并提交' },
    ]
    await runAgentTurn(history as never, deps('conv-replay') as never)

    // The first submit runs; the second identical one is refused at dispatch.
    const clickExecutions = execMock.mock.calls.filter(
      (call) => (call[0] as { action?: string }).action === 'click',
    )
    expect(clickExecutions).toHaveLength(1)
    expect(
      history.some(
        (message) =>
          message.role === 'tool' && String(message.content).includes('already ran earlier'),
      ),
    ).toBe(true)
  })

  it('keeps original page reads in the transcript and only projects stubs into the request', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        reasoning: '',
        toolCalls: [toolCall('c1', 'snapshot_page', {})],
        finishReason: 'tool_calls',
        usage: null,
      } as never)
      .mockResolvedValueOnce({
        content: '',
        reasoning: '',
        toolCalls: [toolCall('c2', 'snapshot_page', {})],
        finishReason: 'tool_calls',
        usage: null,
      } as never)
      .mockResolvedValueOnce({
        content: 'read both',
        reasoning: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: null,
      } as never)

    const history: { role: string; content: string }[] = [
      { role: 'user', content: 'Read the page twice' },
    ]
    await runAgentTurn(history as never, deps('conv-original') as never)

    // AC-5⑤: the transcript (what storage persists) keeps the original page
    // text; only the request projection carries retired stubs.
    const toolContents = history
      .filter((message) => message.role === 'tool')
      .map((message) => String(message.content))
    expect(toolContents.some((content) => content.includes('Confirm your order.'))).toBe(true)
    expect(toolContents.some((content) => content.includes('"retired":true'))).toBe(false)

    const lastRequest = streamMock.mock.calls.at(-1)?.[0] as {
      messages: { role: string; content: string }[]
    }
    expect(
      lastRequest.messages.some(
        (message) => message.role === 'tool' && message.content.includes('"retired":true'),
      ),
    ).toBe(true)
  })

  it('records an executed irreversible action so the next turn can block it', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        reasoning: '',
        toolCalls: [toolCall('c1', 'snapshot_page', {})],
        finishReason: 'tool_calls',
        usage: null,
      } as never)
      .mockResolvedValueOnce({
        content: '',
        reasoning: '',
        toolCalls: [toolCall('c2', 'click', { ref: 'e1' })],
        finishReason: 'tool_calls',
        usage: null,
      } as never)
      .mockResolvedValueOnce({
        content: 'submitted',
        reasoning: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: null,
      } as never)

    await runAgentTurn(
      [{ role: 'user', content: 'Pay for the order' }] as never,
      deps('conv-submit') as never,
    )

    const persisted = saveMock.mock.calls.map((call) => call[0])
    const last = persisted.at(-1)
    expect(last?.steps.some((step) => step.tool === 'click' && step.ok)).toBe(true)
    expect(last?.destructiveOps).toHaveLength(1)
    expect(last?.destructiveOps[0]?.summary).toContain('Pay now')
  })
})
