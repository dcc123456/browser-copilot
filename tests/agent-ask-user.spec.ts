import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentServerMessage } from '../src/lib/messages'
import { advertiseTools, modeAutoApproves, runAgentTurn } from '../src/background/agent'
import { streamCompletion } from '../src/lib/llm'

/**
 * The `ask_user` tool: the model's clarifying-question channel. A panel turn
 * answers through `deps.askUser`; an unattended run (no dep) gets a graceful
 * refusal instead of a hang; a dismissed question tells the model to proceed
 * with a stated assumption.
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
    askUser: vi.fn(async ({ answer }: { answer: string }) => ({ answer, cancelled: false })),
    conversationId: `conv-${Math.random().toString(36).slice(2)}`,
    getMode: async () => 'semi' as const,
    getMaxToolRounds: async () => 4,
    getToolConfig: async () => ({ disabledTools: [] as string[], basePrompt: '' }),
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

function toolResult(
  history: { role: string; name?: string; content?: string }[],
  name: string,
): Record<string, unknown> {
  const entry = [...history].reverse().find((m) => m.role === 'tool' && m.name === name)
  if (!entry) throw new Error(`no tool result for ${name}`)
  return JSON.parse(entry.content ?? '{}') as Record<string, unknown>
}

/** Valid structured suggestions under the mandatory-options contract. */
const OPTIONS = [
  { label: 'A', pros: 'fast', cons: 'risky' },
  { label: 'B', pros: 'safe', cons: 'slow' },
  { label: 'C', pros: 'cheap', cons: 'manual' },
]

describe('ask_user tool loop', () => {
  it('returns the user answer to the model', async () => {
    const askUser = vi.fn(async () => ({ answer: 'Option B', cancelled: false }))
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'ask_user', { question: 'Which one?', options: OPTIONS })],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'buy something' },
    ]
    await runAgentTurn(history as never, deps({ askUser }) as never)

    expect(askUser).toHaveBeenCalledWith({
      question: 'Which one?',
      options: OPTIONS,
    })
    const result = toolResult(history, 'ask_user')
    expect(result['ok']).toBe(true)
    expect(result['answer']).toBe('Option B')
  })

  it('reports a dismissed question so the model can decide itself', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          toolCall('c1', 'ask_user', { question: 'Overwrite the file?', options: OPTIONS }),
        ],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'save it' },
    ]
    await runAgentTurn(
      history as never,
      deps({ askUser: async () => ({ answer: '', cancelled: true }) }) as never,
    )

    const result = toolResult(history, 'ask_user')
    expect(result['ok']).toBe(false)
    expect(result['cancelled']).toBe(true)
    expect(String(result['error'])).toContain('dismissed')
  })

  it('refuses gracefully in unattended runs (no askUser dep)', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'ask_user', { question: 'Which account?', options: OPTIONS })],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'log in' },
    ]
    const sent: AgentServerMessage[] = []
    await runAgentTurn(
      history as never,
      deps({ askUser: undefined, send: (m) => sent.push(m) }) as never,
    )

    const result = toolResult(history, 'ask_user')
    expect(result['ok']).toBe(false)
    expect(String(result['error'])).toContain('unattended')
    const summary = sent.find((m) => m.type === 'tool.result')
    expect(summary && 'summary' in summary && summary.summary).toContain('No interactive user')
  })

  it('asks for a question when the model calls it without one', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'ask_user', { options: ['A'] })],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'hi' },
    ]
    await runAgentTurn(history as never, deps() as never)

    const result = toolResult(history, 'ask_user')
    expect(result['error']).toContain('question')
  })

  it('is refused when the user disabled the tool', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'ask_user', { question: 'Which?' })],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'hi' },
    ]
    await runAgentTurn(
      history as never,
      deps({
        getToolConfig: async () => ({ disabledTools: ['ask_user'], basePrompt: '' }),
      }) as never,
    )

    const result = toolResult(history, 'ask_user')
    expect(result['error']).toContain('disabled')
  })
})

describe('ask_user advertisement and approval', () => {
  it('is advertised in every acting/reading mode except workflow and chat', () => {
    // Workflow generation refuses ask_user outright (the save card IS the
    // review moment there), so the tool is not advertised in that mode either.
    for (const mode of ['semi', 'full', 'readonly'] as const) {
      const names = advertiseTools({ mode }).map((tool) => tool.function.name)
      expect(names).toContain('ask_user')
    }
    expect(advertiseTools({ mode: 'workflow' }).map((tool) => tool.function.name)).not.toContain(
      'ask_user',
    )
    expect(advertiseTools({ mode: 'chat' })).toEqual([])
  })

  it('never pops the approval card — asking IS the interaction', () => {
    for (const mode of ['semi', 'full', 'readonly', 'chat', 'workflow'] as const) {
      expect(modeAutoApproves(mode, 'ask_user')).toBe(true)
    }
  })

  it('is withheld from the advertised set in unattended runs (no askUser dep)', async () => {
    streamMock
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; content: string }[] = [{ role: 'user', content: 'hi' }]
    await runAgentTurn(history as never, deps({ askUser: undefined }) as never)

    const request = streamMock.mock.calls[0]?.[0]
    expect(request).toBeTruthy()
    const names = ((request?.tools ?? []) as { function: { name: string } }[]).map(
      (tool) => tool.function.name,
    )
    expect(names).not.toContain('ask_user')
  })
})

describe('ask_user structured options contract', () => {
  it('rejects a call with fewer than 3 options and never asks the user', async () => {
    const askUser = vi.fn(async () => ({ answer: 'x', cancelled: false }))
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          toolCall('c1', 'ask_user', {
            question: 'Which?',
            options: OPTIONS.slice(0, 2),
          }),
        ],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'hi' },
    ]
    await runAgentTurn(history as never, deps({ askUser }) as never)

    expect(askUser).not.toHaveBeenCalled()
    const result = toolResult(history, 'ask_user')
    expect(String(result['error'])).toContain('3-6')
    expect(String(result['error'])).toContain('pros')
  })

  it('rejects options that miss pros or cons', async () => {
    const askUser = vi.fn(async () => ({ answer: 'x', cancelled: false }))
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          toolCall('c1', 'ask_user', {
            question: 'Which?',
            options: [...OPTIONS.slice(0, 2), { label: 'C', pros: 'cheap' }],
          }),
        ],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'hi' },
    ]
    await runAgentTurn(history as never, deps({ askUser }) as never)

    expect(askUser).not.toHaveBeenCalled()
    const result = toolResult(history, 'ask_user')
    expect(String(result['error'])).toContain('cons')
  })

  it('refuses a stray call in workflow generation mode', async () => {
    const askUser = vi.fn(async () => ({ answer: 'x', cancelled: false }))
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'ask_user', { question: 'Which?', options: OPTIONS })],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'scrape this' },
    ]
    await runAgentTurn(
      history as never,
      deps({ askUser, getMode: async () => 'workflow' as const }) as never,
    )

    expect(askUser).not.toHaveBeenCalled()
    const result = toolResult(history, 'ask_user')
    expect(String(result['error'])).toContain('workflow')
  })
})
