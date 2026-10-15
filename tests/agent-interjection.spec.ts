import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentServerMessage } from '../src/lib/messages'
import type { Interjection } from '../src/background/agent-channel'
import { runAgentTurn } from '../src/background/agent'
import { streamCompletion } from '../src/lib/llm'

/**
 * Mid-turn supplements: instructions the user types while the model is already
 * working. The contract behind "add a note instead of pressing Stop": the note
 * joins the transcript as a user turn at a round boundary — the one point where
 * every `tool_calls` turn is paired with its results, so provider message
 * ordering survives — and the SAME task keeps going.
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

interface TranscriptEntry {
  role: string
  content?: string
  displayContent?: string
  name?: string
  tool_calls?: unknown[]
}

function deps(overrides: Partial<Parameters<typeof runAgentTurn>[1]> = {}) {
  return {
    send: (_message: AgentServerMessage): void => {},
    confirm: vi.fn(async () => true),
    askUser: vi.fn(async () => ({ answer: 'Option B', cancelled: false })),
    conversationId: `conv-${Math.random().toString(36).slice(2)}`,
    getMode: async () => 'semi' as const,
    getMaxToolRounds: async () => 4,
    getToolConfig: async () => ({ disabledTools: [] as string[], basePrompt: '' }),
    ...overrides,
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }
}

const OPTIONS = [
  { label: 'A', pros: 'fast', cons: 'risky' },
  { label: 'B', pros: 'safe', cons: 'slow' },
  { label: 'C', pros: 'cheap', cons: 'manual' },
]

/**
 * The channel queue, stand-in: notes land while a round is in flight and are
 * taken whole at the next boundary.
 */
function supplementQueue() {
  const queue: Interjection[] = []
  return {
    type(noteId: string, text: string): void {
      queue.push({ id: noteId, text })
    },
    take(): Interjection[] {
      return queue.splice(0)
    },
    get size(): number {
      return queue.length
    },
  }
}

/** The `messages` array of the `round`th (0-based) model request. */
function requestMessages(round: number): TranscriptEntry[] {
  const call = streamMock.mock.calls[round]
  if (!call) throw new Error(`no request for round ${round}`)
  return (call[0] as { messages: TranscriptEntry[] }).messages
}

/** The same array without its leading system prompt, i.e. the transcript sent. */
function requestTranscript(round: number): TranscriptEntry[] {
  return requestMessages(round).slice(1)
}

describe('mid-turn supplement injection', () => {
  it('enters the transcript as a user turn, after the round it waited for', async () => {
    const notes = supplementQueue()
    let requests = 0
    streamMock.mockImplementation(async () => {
      requests += 1
      if (requests === 1) {
        // The user types while the first round's tool call is running.
        notes.type('n1', 'use the second account')
        return {
          content: '',
          toolCalls: [toolCall('c1', 'ask_user', { question: 'Which one?', options: OPTIONS })],
        } as never
      }
      return { content: 'done', toolCalls: [] } as never
    })

    const history: TranscriptEntry[] = [{ role: 'user', content: 'buy something' }]
    const sent: AgentServerMessage[] = []
    await runAgentTurn(
      history as never,
      deps({ takeInterjections: notes.take, send: (m) => sent.push(m) }) as never,
    )

    // The supplement sits after the tool result of the round it waited for, so
    // the request stays paired: assistant(tool_calls) → tool → user.
    expect(history.map((entry) => entry.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
    ])
    const injected = history[3]!
    expect(injected.role).toBe('user')
    // The user's own words stay the display text; only the model-facing content
    // carries the "apply this to the task in progress" envelope.
    expect(injected.displayContent).toBe('use the second account')
    expect(injected.content).toContain('use the second account')
    expect(injected.content).toContain('Do not restart the task')
    // And the round's request really carried it, in that position.
    expect(requestTranscript(1)[3]).toMatchObject({ role: 'user' })
  })

  it('announces exactly the notes it applied', async () => {
    const notes = supplementQueue()
    notes.type('n1', 'first')
    notes.type('n2', 'second')
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'ask_user', { question: 'Which?', options: OPTIONS })],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const sent: AgentServerMessage[] = []
    const history: TranscriptEntry[] = [{ role: 'user', content: 'go' }]
    await runAgentTurn(
      history as never,
      deps({ takeInterjections: notes.take, send: (m) => sent.push(m) }) as never,
    )

    const applied = sent.filter((message) => message.type === 'chat.interjection.applied')
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ noteIds: ['n1', 'n2'] })
    // Both notes are user turns, one per note.
    expect(history.filter((entry) => entry.role === 'user')).toHaveLength(3)
    expect(notes.size).toBe(0)
  })

  it('keeps the same turn going when a note arrives during the final answer', async () => {
    const notes = supplementQueue()
    let requests = 0
    streamMock.mockImplementation(async () => {
      requests += 1
      if (requests === 1) {
        // The answer is already streaming when the user adds the constraint.
        notes.type('n1', 'also collect the price')
        return { content: 'here is the list', toolCalls: [] } as never
      }
      return { content: 'here is the list, with prices', toolCalls: [] } as never
    })

    const history: TranscriptEntry[] = [{ role: 'user', content: 'collect the items' }]
    const sent: AgentServerMessage[] = []
    await runAgentTurn(
      history as never,
      deps({ takeInterjections: notes.take, send: (m) => sent.push(m) }) as never,
    )

    // The task did not finish with the note unread, and no second turn opened:
    // one call kept going, so the draft it was building is still the one adjusted.
    expect(requests).toBe(2)
    expect(history.map((entry) => entry.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(sent.some((message) => message.type === 'chat.interjection.applied')).toBe(true)
  })

  it('ends after one request when nothing was typed', async () => {
    const notes = supplementQueue()
    streamMock.mockResolvedValue({ content: 'plain answer', toolCalls: [] } as never)

    const history: TranscriptEntry[] = [{ role: 'user', content: 'hi' }]
    await runAgentTurn(history as never, deps({ takeInterjections: notes.take }) as never)

    expect(streamMock).toHaveBeenCalledTimes(1)
    expect(history.map((entry) => entry.role)).toEqual(['user', 'assistant'])
  })

  it('runs without a queue at all, so unattended entry points are unaffected', async () => {
    streamMock.mockResolvedValue({ content: 'answer', toolCalls: [] } as never)

    const history: TranscriptEntry[] = [{ role: 'user', content: 'hi' }]
    await runAgentTurn(history as never, deps() as never)

    expect(streamMock).toHaveBeenCalledTimes(1)
  })
})
