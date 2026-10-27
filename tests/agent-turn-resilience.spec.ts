/**
 * Turn resilience (see specs/2026-10-27-chat-turn-resilience-design.md):
 * a turn must not spend its whole round budget repeating a call that cannot
 * succeed, and a panel turn that does exhaust the budget must end with a
 * summary instead of a bare stop — while unattended runs keep the status line
 * their callers classify on.
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

function jsCall(id: string) {
  return {
    id,
    type: 'function' as const,
    function: { name: 'run_javascript', arguments: JSON.stringify({ code: 'return 1' }) },
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
      .mockResolvedValueOnce({ content: '', toolCalls: [jsCall('c1')] } as never)
      .mockResolvedValueOnce({ content: '', toolCalls: [jsCall('c2')] } as never)
      .mockResolvedValueOnce({ content: '', toolCalls: [jsCall('c3')] } as never)
      .mockResolvedValueOnce({ content: '', toolCalls: [jsCall('c4')] } as never)
      .mockResolvedValueOnce({ content: 'moving on', toolCalls: [] } as never)

    const history: { role: string; content?: unknown }[] = [{ role: 'user', content: 'do it' }]
    await runAgentTurn(history as never, deps() as never)

    // The fourth call is refused before the driver runs.
    expect(execOnActiveTabMock).toHaveBeenCalledTimes(3)
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
      .mockResolvedValueOnce({ content: '', toolCalls: [jsCall('c1')] } as never)
      .mockResolvedValueOnce({ content: '', toolCalls: [jsCall('c2')] } as never)
      .mockResolvedValueOnce({ content: '', toolCalls: [jsCall('c3')] } as never)
      .mockResolvedValueOnce({ content: '', toolCalls: [jsCall('c4')] } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; content?: unknown }[] = [{ role: 'user', content: 'do it' }]
    await runAgentTurn(history as never, deps() as never)

    expect(execOnActiveTabMock).toHaveBeenCalledTimes(4)
    expect(toolContents(history).join(' ')).not.toMatch(/retrying cannot change/)
  })
})

describe('round budget', () => {
  function successfulJs() {
    execOnActiveTabMock.mockResolvedValue({
      ok: true,
      data: 1,
      found: true,
      frameUrl: 'https://x.test/',
      isTopFrame: true,
    })
  }

  it('extends a panel turn past its budget instead of ending it', async () => {
    successfulJs()
    streamMock
      .mockResolvedValueOnce({ content: '', toolCalls: [jsCall('c1')] } as never)
      .mockResolvedValueOnce({ content: '', toolCalls: [jsCall('c2')] } as never)
      .mockResolvedValueOnce({ content: '', toolCalls: [jsCall('c3')] } as never)
      .mockResolvedValueOnce({ content: 'RESULT: task finished', toolCalls: [] } as never)

    const history: { role: string; content?: unknown }[] = [{ role: 'user', content: 'do it' }]
    await runAgentTurn(
      history as never,
      deps({ takeInterjections: () => [], getMaxToolRounds: async () => 2 }) as never,
    )

    // Round 3 runs on the extended budget (2 was the configured batch), and the
    // request still offers tools — this is a continuation, not a wrap-up.
    expect(streamMock).toHaveBeenCalledTimes(4)
    expect(streamMock.mock.calls[2]![0].tools?.length).toBeGreaterThan(0)
    expect(history.at(-1)).toMatchObject({ role: 'assistant', content: 'RESULT: task finished' })
    expect(
      sent.some((message) => message.type === 'status' && /another batch/.test(message.text)),
    ).toBe(true)
    expect(
      sent.some((message) => message.type === 'status' && /Stopped after/.test(message.text)),
    ).toBe(false)
  })

  it('still ends with a tools-off summary at the safety ceiling', async () => {
    successfulJs()
    // A model that never answers while tools are on; only the tools-off
    // wrap-up request gets prose.
    streamMock.mockImplementation(async (request: { tools?: unknown[] }) =>
      request.tools === undefined
        ? ({ content: 'SUMMARY: 10 rounds done, still blocked', toolCalls: [] } as never)
        : ({ content: '', toolCalls: [jsCall(`c${Math.random()}`)] } as never),
    )

    const history: { role: string; content?: unknown }[] = [{ role: 'user', content: 'do it' }]
    await runAgentTurn(
      history as never,
      deps({ takeInterjections: () => [], getMaxToolRounds: async () => 1 }) as never,
    )

    // One-round batches → the ceiling is reached after 10 rounds, then the
    // single tools-off wrap-up request.
    expect(streamMock).toHaveBeenCalledTimes(11)
    const wrapUp = streamMock.mock.calls[10]![0]
    expect(wrapUp.tools).toBeUndefined()
    const lastMessage = wrapUp.messages.at(-1)
    expect(lastMessage?.role).toBe('user')
    expect(String(lastMessage?.content)).toMatch(/All 10 tool rounds/)
    expect(history.at(-1)).toMatchObject({ role: 'assistant' })
  })

  it('keeps the hard cap and status line for unattended turns', async () => {
    successfulJs()
    streamMock
      .mockResolvedValueOnce({ content: '', toolCalls: [jsCall('c1')] } as never)
      .mockResolvedValueOnce({ content: '', toolCalls: [jsCall('c2')] } as never)

    const history: { role: string; content?: unknown }[] = [{ role: 'user', content: 'do it' }]
    await runAgentTurn(history as never, deps({ getMaxToolRounds: async () => 2 }) as never)

    expect(streamMock).toHaveBeenCalledTimes(2)
    expect(
      sent.some(
        (message) => message.type === 'status' && /Stopped after 2 tool rounds/.test(message.text),
      ),
    ).toBe(true)
  })
})
