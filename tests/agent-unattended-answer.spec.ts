/**
 * Tests for `runUnattendedPrompt`'s answer assembly — the string the workflow
 * `ai-agent` block stores into its output variable (and the Feishu bot /
 * scheduler send to the user):
 *   - only the text streamed AFTER the last tool call is the answer (the text
 *     in earlier rounds is narration, not the reply);
 *   - reasoning-model `<think>` blocks and a wrapping code fence are stripped;
 *   - a turn with no final-round text falls back to the full transcript;
 *   - a thinking-only reply is reported as a failure, not as the answer.
 *
 * `runAgentTurn` is mocked with a scripted `send` sequence; no model/network.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const runAgentTurn = vi.fn()
vi.mock('../src/background/agent', () => ({
  runAgentTurn: (...args: unknown[]) => runAgentTurn(...args),
}))
vi.mock('../src/background/window-policy', () => ({
  resolveUnattendedScope: vi.fn(async () => undefined),
}))
vi.mock('../src/background/keepalive', () => ({
  retain: vi.fn(),
  release: vi.fn(),
}))
const getSettingsMock = vi.fn()
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return { ...actual, getSettings: (...args: unknown[]) => getSettingsMock(...args) }
})

import { runUnattendedPrompt } from '../src/background/agent-unattended'

type FakeMessage = { type: string; text?: string; name?: string; summary?: string }

/** Makes the mocked agent loop replay a scripted `send` sequence. */
function scriptTurn(messages: FakeMessage[]): void {
  runAgentTurn.mockImplementation(
    async (_history: unknown, deps: { send: (m: unknown) => void }) => {
      for (const message of messages) deps.send(message)
      return null
    },
  )
}

describe('runUnattendedPrompt answer assembly', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSettingsMock.mockResolvedValue({})
  })

  it('returns only the final-round text, dropping pre-tool narration', async () => {
    scriptTurn([
      { type: 'delta', text: 'Let me check the page first. ' },
      { type: 'tool.start', name: 'read_page' },
      { type: 'tool.result', summary: 'page text' },
      { type: 'delta', text: 'The final ' },
      { type: 'delta', text: 'answer.' },
    ])
    const steps: string[] = []
    const result = await runUnattendedPrompt('do it', 'conv', 'readonly', {
      onStep: (kind, text) => steps.push(`${kind}:${text}`),
    })
    expect(result.ok).toBe(true)
    expect(result.answer).toBe('The final answer.')
    // Progress steps still flow through for the run log.
    expect(steps).toContain('tool:→ read_page')
  })

  it('strips think blocks and a wrapping fence from the answer', async () => {
    scriptTurn([{ type: 'delta', text: '<think>chain of thought</think>\n```json\n{"a":1}\n```' }])
    const result = await runUnattendedPrompt('do it', 'conv')
    expect(result.ok).toBe(true)
    expect(result.answer).toBe('{"a":1}')
  })

  it('falls back to the full transcript when no final-round text exists', async () => {
    scriptTurn([
      { type: 'delta', text: 'narration only' },
      { type: 'tool.start', name: 't' },
    ])
    const result = await runUnattendedPrompt('do it', 'conv')
    expect(result.ok).toBe(true)
    expect(result.answer).toBe('narration only')
  })

  it('reports a thinking-only reply as a failure instead of the junk', async () => {
    scriptTurn([{ type: 'delta', text: '<think>reasoning with no answer ever' }])
    const result = await runUnattendedPrompt('do it', 'conv')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no usable answer/i)
  })

  it('keeps the no-answer-at-all error text when nothing streamed', async () => {
    scriptTurn([])
    const result = await runUnattendedPrompt('do it', 'conv')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/produced no answer/i)
  })
})
