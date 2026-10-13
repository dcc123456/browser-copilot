import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentServerMessage } from '../src/lib/messages'
import { runAgentTurn } from '../src/background/agent'
import {
  closeInterruptedToolRounds,
  streamCompletion,
  toApiMessages,
  type WireMessage,
  type WireToolCall,
} from '../src/lib/llm'

/**
 * A turn interrupted by Stop leaves an assistant `tool_calls` turn with no
 * matching `role: 'tool'` results, and the turn's `finally` persists exactly
 * that (`background/index.ts`). Replayed on every later request, the broken
 * pairing made providers fail the whole conversation, so the outbound request
 * must repair it (`lib/llm.ts`).
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

const streamMock = vi.mocked(streamCompletion)

beforeEach(() => {
  getActiveProviderMock.mockResolvedValue({
    apiKey: 'k',
    baseUrl: 'https://x',
    model: 'm',
    label: 'test',
  })
})

afterEach(() => {
  streamMock.mockReset()
})

function call(id: string, name: string, args: string): WireToolCall {
  return { id, type: 'function', function: { name, arguments: args } }
}

function assistant(calls: WireToolCall[], content = ''): WireMessage {
  return { role: 'assistant', content, tool_calls: calls }
}

function result(id: string, content = '{"ok":true}'): WireMessage {
  return { role: 'tool', tool_call_id: id, content }
}

function contentOf(message: WireMessage | undefined): string {
  return String((message as { content?: string } | undefined)?.content ?? '')
}

/** A request payload in which every assistant tool round is fully answered. */
function expectAnsweredRounds(payload: unknown[]): void {
  for (let index = 0; index < payload.length; index += 1) {
    const message = payload[index] as { role?: string; tool_calls?: WireToolCall[] }
    if (message?.role !== 'assistant' || !message.tool_calls) continue
    message.tool_calls.forEach((expectedCall, offset) => {
      const following = payload[index + 1 + offset] as { role?: string; tool_call_id?: string }
      expect(following?.role).toBe('tool')
      expect(following?.tool_call_id).toBe(expectedCall.id)
    })
    index += message.tool_calls.length
  }
}

describe('closeInterruptedToolRounds', () => {
  it('leaves an already-paired transcript untouched', () => {
    const paired: WireMessage[] = [
      { role: 'user', content: 'pin it' },
      assistant([call('c1', 'pin_tab', '{"tabId":1}')]),
      result('c1'),
      { role: 'assistant', content: 'done' },
    ]
    expect(closeInterruptedToolRounds(paired)).toEqual(paired)
  })

  it('answers every call of a dangling tool turn with an interruption note', () => {
    const repaired = closeInterruptedToolRounds([
      { role: 'user', content: 'pin it' },
      assistant([call('c1', 'pin_tab', '{"tabId":1}')], 'Let me pin that tab.'),
    ])
    expect(repaired[1]).toEqual(
      assistant([call('c1', 'pin_tab', '{"tabId":1}')], 'Let me pin that tab.'),
    )
    expect(repaired[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
    expect(contentOf(repaired[2])).toContain('interrupted')
  })

  it('fills only the missing results of a half-run round, in call order', () => {
    const repaired = closeInterruptedToolRounds([
      assistant([call('c1', 'pin_tab', '{}'), call('c2', 'unpin_tab', '{}')]),
      result('c2', '{"unpinned":true}'),
    ])
    expect(repaired.map((message) => message.role)).toEqual(['assistant', 'tool', 'tool'])
    expect(
      repaired.slice(1).map((message) => (message as { tool_call_id: string }).tool_call_id),
    ).toEqual(['c1', 'c2'])
    expect(contentOf(repaired[1])).toContain('interrupted')
    expect(contentOf(repaired[2])).toBe('{"unpinned":true}')
  })

  it('repairs arguments a truncated stream left half-written', () => {
    const repaired = closeInterruptedToolRounds([assistant([call('c1', 'fill', '{"text": "hal')])])
    const calls = (repaired[0] as { tool_calls: WireToolCall[] }).tool_calls
    expect(calls[0]!.function.arguments).toBe('{}')
    expect(() => JSON.parse(calls[0]!.function.arguments)).not.toThrow()
  })

  it('drops a call that has no id, keeping the turn as plain text when none is left', () => {
    const repaired = closeInterruptedToolRounds([
      assistant([call('', 'pin_tab', '{}'), call('c2', 'unpin_tab', '{}')]),
    ])
    expect(repaired[0]).toMatchObject({ tool_calls: [call('c2', 'unpin_tab', '{}')] })
    const idless = closeInterruptedToolRounds([assistant([call('', 'pin_tab', '{}')], 'thinking')])
    expect(idless).toEqual([{ role: 'assistant', content: 'thinking' }])
  })

  it('drops results whose assistant turn is gone, and duplicate results', () => {
    const repaired = closeInterruptedToolRounds([
      result('gone'),
      { role: 'user', content: 'again' },
      assistant([call('c1', 'pin_tab', '{}')]),
      result('c1', '{"first":true}'),
      result('c1', '{"second":true}'),
      { role: 'assistant', content: 'done' },
    ])
    expect(repaired.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(contentOf(repaired[2])).toBe('{"first":true}')
  })

  it('normalizes a null content on a tool-call turn', () => {
    const repaired = closeInterruptedToolRounds([
      { role: 'assistant', content: null, tool_calls: [call('c1', 'pin_tab', '{}')] },
    ])
    expect(repaired[0]).toMatchObject({ role: 'assistant', content: '' })
  })
})

describe('toApiMessages', () => {
  it('never sends an unanswered tool call', () => {
    const payload = toApiMessages([
      { role: 'user', content: 'pin it' },
      assistant([call('c1', 'pin_tab', '{}'), call('c2', 'unpin_tab', 'trunc')]),
      result('c1'),
    ])
    expect(payload).toHaveLength(4)
    expectAnsweredRounds(payload)
  })

  it('keeps extension-only user fields out of a repaired transcript', () => {
    const payload = toApiMessages([
      { role: 'user', content: 'model text', displayContent: 'raw text' },
      assistant([call('c1', 'pin_tab', '{}')]),
    ])
    expect(payload[0]).toEqual({ role: 'user', content: 'model text' })
    expectAnsweredRounds(payload)
  })
})

describe('runAgentTurn interrupted by Stop', () => {
  function deps(overrides: Partial<Parameters<typeof runAgentTurn>[1]> = {}) {
    return {
      send: (_message: AgentServerMessage): void => {},
      confirm: vi.fn(async () => true),
      conversationId: `conv-${Math.random().toString(36).slice(2)}`,
      getMode: async () => 'full' as const,
      getMaxToolRounds: async () => 6,
      getToolConfig: async () => ({ disabledTools: [], basePrompt: '' }),
      ...overrides,
    }
  }

  it('leaves a dangling tool turn in the transcript, and a valid request after it', async () => {
    const controller = new AbortController()
    // Stop landed as the model's tool round was produced: the round is pushed,
    // then the loop bails before executing any of its calls.
    streamMock.mockImplementationOnce(async () => {
      controller.abort()
      return {
        content: '',
        toolCalls: [call('c1', 'pin_tab', '{}')],
        finishReason: 'tool_calls',
      } as never
    })

    const history: WireMessage[] = [{ role: 'user', content: 'pin this tab' }]
    await runAgentTurn(history, deps({ signal: controller.signal }) as never)

    expect(history[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [call('c1', 'pin_tab', '{}')],
    })
    expect(history.filter((message) => message.role === 'tool')).toHaveLength(0)

    // What the user sends next must not carry the unresolved round as-is.
    history.push({ role: 'user', content: 'never mind, read the page instead' })
    expectAnsweredRounds(toApiMessages(history))
  })
})
