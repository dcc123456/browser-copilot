import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentServerMessage } from '../src/lib/messages'
import { runAgentTurn } from '../src/background/agent'
import { streamCompletion } from '../src/lib/llm'

/**
 * The semi-auto gate at the turn level: the risk classifier is unit-tested in
 * `confirm.spec.ts`; here the point is that `runOneToolCall` actually consults
 * it — a benign click runs without a card, a payment click waits for one, and
 * a declined click never reaches the driver.
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

function deps(overrides: Partial<Parameters<typeof runAgentTurn>[1]> = {}) {
  return {
    send: (_message: AgentServerMessage): void => {},
    confirm: vi.fn(async () => true),
    conversationId: `conv-${Math.random().toString(36).slice(2)}`,
    getMode: async () => 'semi' as const,
    getMaxToolRounds: async () => 4,
    getToolConfig: async () => ({ disabledTools: [], basePrompt: '' }),
    ...overrides,
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    id,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  }
}

function clickTarget(text: string) {
  return { target: { primary: { how: 'text', value: text }, fallbacks: [] } }
}

function toolResult(
  history: { role: string; name?: string; content?: string }[],
  name: string,
): Record<string, unknown> {
  const entry = [...history].reverse().find((m) => m.role === 'tool' && m.name === name)
  if (!entry) throw new Error(`no tool result for ${name}`)
  return JSON.parse(entry.content ?? '{}') as Record<string, unknown>
}

describe('semi-auto confirmation at dispatch', () => {
  it('runs a harmless named click without asking', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'click', clickTarget('Next'))],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const confirm = vi.fn(async () => true)
    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'go to the next page' },
    ]
    await runAgentTurn(history as never, deps({ confirm }) as never)

    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks before a payment click and reports a decline without executing', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'click', clickTarget('Pay now'))],
      } as never)
      .mockResolvedValueOnce({ content: 'ok, not paid', toolCalls: [] } as never)

    const confirm = vi.fn(async () => false)
    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'buy it' },
    ]
    await runAgentTurn(history as never, deps({ confirm }) as never)

    expect(confirm).toHaveBeenCalledTimes(1)
    const result = toolResult(history, 'click')
    expect(String(result['error'] ?? '')).toContain('declined')
  })

  it('does not ask before scrolling', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'scroll', { mode: 'by', y: 200 })],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const confirm = vi.fn(async () => true)
    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'scroll a bit' },
    ]
    await runAgentTurn(history as never, deps({ confirm }) as never)

    expect(confirm).not.toHaveBeenCalled()
  })

  it('full auto never asks, even for a payment click', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'click', clickTarget('Pay now'))],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const confirm = vi.fn(async () => false)
    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'buy it' },
    ]
    await runAgentTurn(history as never, deps({ confirm, getMode: async () => 'full' }) as never)

    expect(confirm).not.toHaveBeenCalled()
  })
})
