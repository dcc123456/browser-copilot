/**
 * R10 batch 1: the explicit goal budget drives the loop, a pause waits for a
 * decision (and settles when nobody can answer), renewal continues the same
 * turn, and completion needs an explicit declaration with evidence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentTurn } from '../src/background/agent'
import type { AgentServerMessage } from '../src/lib/messages'
import { streamCompletion } from '../src/lib/llm'
import type { StreamResult, WireMessage } from '../src/lib/llm'
import type { TaskProgress } from '../src/lib/task-progress'

vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: vi.fn() }
})

const PAGE = {
  url: 'https://shop.test/p',
  title: 'P',
  text: 'page',
  truncated: false,
  selection: '',
  elements: [],
  elementsTruncated: false,
  frameUrl: 'https://shop.test/p',
  isTopFrame: true,
  forms: [],
  scrollHeight: 800,
  scrollY: 0,
  viewportHeight: 800,
}
const execMock = vi.fn(async (request: { action?: string }) =>
  request.action === 'progress_signature' ? { ok: true, data: 'SIG' } : { ok: true, data: {} },
)
const snapshotMock = vi.fn(async () => PAGE)
vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return {
    ...actual,
    execOnActiveTab: (request: { action?: string }) => execMock(request),
    snapshotActiveTab: () => snapshotMock(),
  }
})

let stored: TaskProgress | undefined
const saveMock = vi.fn(async (progress: TaskProgress) => {
  stored = structuredClone(progress)
})
const loadMock = vi.fn(async () => stored)
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return {
    ...actual,
    getActiveProvider: async () => ({ apiKey: 'k', baseUrl: 'https://x', model: 'm', label: 't' }),
    addHistory: async () => {},
    loadTaskProgress: () => loadMock(),
    saveTaskProgress: (progress: TaskProgress) => saveMock(progress),
    taskCostSince: async () => ({
      inputTokens: 100,
      cachedInputTokens: 50,
      outputTokens: 10,
      requests: 1,
    }),
  }
})

const streamMock = vi.mocked(streamCompletion)
const events: AgentServerMessage[] = []

function toolCall(id: string, name: string, args: Record<string, unknown> = {}) {
  return { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }
}

function scriptTool(tool: string, rounds: number): void {
  let sent = 0
  streamMock.mockImplementation((async () => {
    sent += 1
    if (sent > rounds) {
      return { content: 'done', reasoning: '', toolCalls: [], finishReason: 'stop', usage: null }
    }
    return {
      content: '',
      reasoning: '',
      toolCalls: [
        tool === 'goal_complete'
          ? toolCall(`c${sent}`, 'goal_complete', {
              summary: 'Order placed',
              evidence: [{ kind: 'url', value: 'https://shop.test/order/42' }],
            })
          : toolCall(`c${sent}`, 'snapshot_page', {}),
      ],
      finishReason: 'tool_calls',
      usage: null,
    } as StreamResult
  }) as never)
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    send: (message: AgentServerMessage) => events.push(message),
    confirm: async () => true,
    conversationId: 'goal-conv',
    getMode: async () => 'full' as const,
    getMaxToolRounds: async () => 20,
    getToolConfig: async () => ({ disabledTools: [] as string[], basePrompt: '' }),
    ...overrides,
  }
}

beforeEach(() => {
  stored = undefined
  events.length = 0
  saveMock.mockClear()
  loadMock.mockClear()
  execMock.mockClear()
  snapshotMock.mockClear()
  streamMock.mockReset()
})

describe('explicit goal budget in the loop', () => {
  it('pauses at the budget, reports six items, and renewal continues the same turn', async () => {
    scriptTool('snapshot_page', 4)
    const decisions: Array<{ rounds: number } | null> = [{ rounds: 3 }]
    await runAgentTurn(
      [{ role: 'user', content: 'watch the price' }] as never,
      deps({
        getMaxToolRounds: async () => 2,
        awaitGoalDecision: async () => decisions.shift() ?? null,
      }) as never,
    )

    const report = events.find((event) => event.type === 'goal.budgetExhausted')
    expect(report).toBeDefined()
    if (report?.type === 'goal.budgetExhausted') {
      expect(report.report).toMatchObject({
        goal: 'watch the price',
        usedRounds: 2,
        maxRounds: 2,
        remainingRounds: 0,
        stopReason: 'budget',
        nextActions: ['renew', 'change-goal', 'stop'],
      })
      expect(report.report.cost?.requests).toBe(1)
    }
    // Renewal continued the SAME task: the persisted goal was extended, and the
    // spent counter was not reset by the renewal itself.
    expect(stored?.goal?.maxRounds).toBe(5)
    expect(stored?.goal?.roundsStarted).toBe(4)
    expect(stored?.goal?.status).toBe('active')
  })

  it('applies a budget edited from the panel while the task is still running', async () => {
    let sent = 0
    streamMock.mockImplementation((async () => {
      sent += 1
      // The panel writes the new budget straight to storage mid-round; the loop
      // must pick it up instead of rolling it back with its own round save.
      if (sent === 2 && stored?.goal) {
        stored = { ...stored, goal: { ...stored.goal, maxRounds: 3 } }
      }
      // Safety net: without the fix this would run the whole default budget.
      if (sent > 6) {
        return { content: 'done', reasoning: '', toolCalls: [], finishReason: 'stop', usage: null }
      }
      return {
        content: '',
        reasoning: '',
        toolCalls: [toolCall(`c${sent}`, 'snapshot_page', {})],
        finishReason: 'tool_calls',
        usage: null,
      } as StreamResult
    }) as never)

    await runAgentTurn([{ role: 'user', content: 'watch the price' }] as never, deps() as never)

    // The edited budget survived the run and the loop paused at it, not at 20.
    expect(stored?.goal?.maxRounds).toBe(3)
    expect(stored?.goal?.roundsStarted).toBe(3)
    expect(stored?.goal?.status).toBe('paused')
    const report = events.find((event) => event.type === 'goal.budgetExhausted')
    if (report?.type !== 'goal.budgetExhausted') throw new Error('no budget report')
    expect(report.report.usedRounds).toBe(3)
    expect(report.report.maxRounds).toBe(3)
  })

  it('settles (does not hang) when no human can decide', async () => {
    scriptTool('snapshot_page', 5)
    await runAgentTurn(
      [{ role: 'user', content: 'watch the price' }] as never,
      deps({ getMaxToolRounds: async () => 1 }) as never,
    )
    expect(events.some((event) => event.type === 'goal.budgetExhausted')).toBe(true)
    expect(
      events.some(
        (event) => event.type === 'status' && event.text.includes('Goal budget exhausted'),
      ),
    ).toBe(true)
    expect(stored?.goal?.status).toBe('paused')
  })

  it('completes only on an explicit goal_complete with evidence', async () => {
    scriptTool('goal_complete', 1)
    await runAgentTurn([{ role: 'user', content: 'place the order' }] as never, deps() as never)
    expect(stored?.goal?.status).toBe('done')
    expect(stored?.goal?.evidence?.[0]).toEqual({
      kind: 'url',
      value: 'https://shop.test/order/42',
    })
    expect(
      events.some((event) => event.type === 'goal.state' && event.goal.status === 'done'),
    ).toBe(true)
  })

  it('refuses a completion without evidence and keeps the task active', async () => {
    streamMock.mockResolvedValueOnce({
      content: '',
      reasoning: '',
      toolCalls: [toolCall('c1', 'goal_complete', { summary: 'done' })],
      finishReason: 'tool_calls',
      usage: null,
    } as never)
    streamMock.mockResolvedValueOnce({
      content: 'done',
      reasoning: '',
      toolCalls: [],
      finishReason: 'stop',
      usage: null,
    } as never)
    const history: WireMessage[] = [{ role: 'user', content: 'place the order' }]
    await runAgentTurn(history as never, deps() as never)
    expect(stored?.goal?.status).toBe('active')
    expect(
      history.some(
        (message) =>
          message.role === 'tool' && String(message.content).includes('Completion needs at least'),
      ),
    ).toBe(true)
  })

  it('keeps the same goal (and its spent rounds) when the model never declares completion', async () => {
    scriptTool('snapshot_page', 1)
    await runAgentTurn([{ role: 'user', content: 'task A' }] as never, deps() as never)
    const afterFirst = stored?.goal?.roundsStarted ?? 0
    expect(afterFirst).toBeGreaterThan(0)

    scriptTool('snapshot_page', 1)
    await runAgentTurn([{ role: 'user', content: 'continue' }] as never, deps() as never)
    // A second message must NOT reset the budget (AC-17③).
    expect(stored?.goal?.summary).toBe('task A')
    expect(stored?.goal?.roundsStarted).toBeGreaterThan(afterFirst)
  })
})
