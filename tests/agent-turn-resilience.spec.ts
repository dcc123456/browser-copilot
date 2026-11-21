/**
 * Turn resilience (see specs/2026-10-27-chat-turn-resilience-design.md):
 * a turn must not spend its whole round budget repeating a call that cannot
 * succeed. The round limit is now the goal's EXPLICIT budget (spec R10): a
 * panel turn pauses at it and continues after renewal; an unattended turn
 * settles paused and reports the budget instead of hanging.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runAgentTurn } from '../src/background/agent'
import type { AgentServerMessage } from '../src/lib/messages'
import { streamCompletion } from '../src/lib/llm'

vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: vi.fn() }
})

const execOnActiveTabMock = vi.fn()
vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return { ...actual, execOnActiveTab: (...args: unknown[]) => execOnActiveTabMock(...args) }
})

const getActiveProviderMock = vi.fn()
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return { ...actual, getActiveProvider: (...args: unknown[]) => getActiveProviderMock(...args) }
})

const streamMock = vi.mocked(streamCompletion)
const sent: AgentServerMessage[] = []

const CSP_ERROR =
  '该页面的内容安全策略（CSP）禁止执行自定义 JavaScript（未允许 unsafe-eval），无法在此页面运行 JS 代码。'

beforeEach(() => {
  sent.length = 0
  getActiveProviderMock.mockResolvedValue({
    apiKey: 'k',
    baseUrl: 'https://x',
    model: 'm',
    label: 'test',
  })
  execOnActiveTabMock.mockReset()
})

afterEach(() => {
  streamMock.mockReset()
})

// A CORE page action: `run_javascript` now rides the on-demand `script` group,
// so the first call in a turn would spend a round on the auto-load hint instead
// of reaching the driver — this spec is about what happens once the driver runs.
function clickCall(id: string) {
  return {
    id,
    type: 'function' as const,
    function: {
      name: 'click',
      arguments: JSON.stringify({
        target: { primary: { how: 'css', value: '#go' }, fallbacks: [] },
      }),
    },
  }
}

function deps(overrides: Partial<Parameters<typeof runAgentTurn>[1]> = {}) {
  return {
    send: (message: AgentServerMessage): void => {
      sent.push(message)
    },
    confirm: vi.fn(async () => true),
    conversationId: `conv-${Math.random().toString(36).slice(2)}`,
    getMode: async () => 'full' as const,
    getMaxToolRounds: async () => 6,
    getToolConfig: async () => ({ disabledTools: [], basePrompt: '' }),
    ...overrides,
  }
}

function toolContents(history: { role: string; content?: unknown }[]): string[] {
  return history.filter((m) => m.role === 'tool').map((m) => String(m.content ?? ''))
}

describe('repeated unchangeable failures', () => {
  it('stops executing a tool after three identical page-policy failures', async () => {
    execOnActiveTabMock.mockResolvedValue({
      ok: false,
      error: CSP_ERROR,
      found: true,
      frameUrl: 'https://x.test/',
      isTopFrame: true,
    })
    streamMock
      .mockResolvedValueOnce({ content: '', toolCalls: [clickCall('c1')] } as never)
      .mockResolvedValueOnce({ content: '', toolCalls: [clickCall('c2')] } as never)
      .mockResolvedValueOnce({ content: '', toolCalls: [clickCall('c3')] } as never)
      .mockResolvedValueOnce({ content: '', toolCalls: [clickCall('c4')] } as never)
      .mockResolvedValueOnce({ content: 'moving on', toolCalls: [] } as never)

    const history: { role: string; content?: unknown }[] = [{ role: 'user', content: 'do it' }]
    await runAgentTurn(history as never, deps() as never)

    // The fourth call is refused before the driver runs. Count CLICKS only:
    // the loop also samples `progress_signature`, a read-only probe.
    expect(
      execOnActiveTabMock.mock.calls.filter(
        (call) => (call[0] as { action?: string }).action === 'click',
      ),
    ).toHaveLength(3)
    const results = toolContents(history)
    expect(results).toHaveLength(4)
    expect(results[3]).toMatch(/retrying cannot change/)
    expect(results[3]).toMatch(/Do not call it again/)
  })

  it('never blocks a retryable failure class', async () => {
    execOnActiveTabMock.mockResolvedValue({
      ok: false,
      error: 'Element not found for selector .x',
      found: false,
      frameUrl: 'https://x.test/',
      isTopFrame: true,
    })
    streamMock
      .mockResolvedValueOnce({ content: '', toolCalls: [clickCall('c1')] } as never)
      .mockResolvedValueOnce({ content: '', toolCalls: [clickCall('c2')] } as never)
      .mockResolvedValueOnce({ content: '', toolCalls: [clickCall('c3')] } as never)
      .mockResolvedValueOnce({ content: '', toolCalls: [clickCall('c4')] } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; content?: unknown }[] = [{ role: 'user', content: 'do it' }]
    await runAgentTurn(history as never, deps() as never)

    expect(
      execOnActiveTabMock.mock.calls.filter(
        (call) => (call[0] as { action?: string }).action === 'click',
      ),
    ).toHaveLength(4)
    expect(toolContents(history).join(' ')).not.toMatch(/retrying cannot change/)
  })
})

describe('explicit goal budget', () => {
  function successfulClick() {
    execOnActiveTabMock.mockResolvedValue({
      ok: true,
      data: 1,
      found: true,
      frameUrl: 'https://x.test/',
      isTopFrame: true,
    })
  }

  it('pauses at the budget and continues after the user renews', async () => {
    successfulClick()
    let round = 0
    streamMock.mockImplementation((async () => {
      round += 1
      return round <= 3
        ? ({ content: '', toolCalls: [clickCall(`c${round}`)] } as never)
        : ({ content: 'RESULT: task finished', toolCalls: [] } as never)
    }) as never)

    const history: { role: string; content?: unknown }[] = [{ role: 'user', content: 'do it' }]
    await runAgentTurn(
      history as never,
      deps({
        takeInterjections: () => [],
        getMaxToolRounds: async () => 2,
        awaitGoalDecision: async () => ({ rounds: 2 }),
      }) as never,
    )

    // 2 rounds spend the budget, the pause resolves with +2, then the model
    // finishes on the extended budget — the SAME turn throughout.
    expect(streamMock).toHaveBeenCalledTimes(4)
    expect(history.at(-1)).toMatchObject({ role: 'assistant', content: 'RESULT: task finished' })
    expect(sent.some((message) => message.type === 'goal.budgetExhausted')).toBe(true)
    expect(
      sent.some(
        (message) =>
          message.type === 'status' && /batch|step|\d+ (tool )?rounds/i.test(message.text),
      ),
    ).toBe(false)
  })

  it('ends a paused unattended turn instead of hanging', async () => {
    successfulClick()
    streamMock.mockResolvedValue({ content: '', toolCalls: [clickCall('c1')] } as never)

    const history: { role: string; content?: unknown }[] = [{ role: 'user', content: 'do it' }]
    await runAgentTurn(history as never, deps({ getMaxToolRounds: async () => 1 }) as never)

    // No decision channel: exactly one round, then the pause is reported and
    // the turn SETTLES — no hidden ceiling, no infinite loop.
    expect(streamMock).toHaveBeenCalledTimes(1)
    expect(sent.some((message) => message.type === 'goal.budgetExhausted')).toBe(true)
    expect(
      sent.some(
        (message) => message.type === 'status' && message.text.includes('Goal budget exhausted'),
      ),
    ).toBe(true)
  })
})
