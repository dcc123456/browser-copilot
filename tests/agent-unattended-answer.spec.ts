/**
 * Tests for `runUnattendedPrompt`'s answer assembly — the string the workflow
 * `ai-agent` block stores into its output variable (and the Feishu bot /
 * scheduler send to the user):
 *   - only the text streamed AFTER the last tool call is the answer (the text
 *     in earlier rounds is narration, not the reply);
 *   - a turn that ends on a tool call has NO answer, and saying so beats
 *     handing the caller its narration;
 *   - reasoning-model `<think>` blocks and a wrapping code fence are stripped;
 *   - a thinking-only reply is reported as a failure, not as the answer.
 *
 * `runAgentTurn` is mocked with a scripted `send` sequence; no model/network.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const runAgentTurn = vi.fn()
vi.mock('../src/background/agent', () => {
  /**
   * Stub of the real classification (a copy of `agent.ts`'s read set), because
   * importing the real module for one predicate would pull the whole service
   * worker into a Node test. The point tested here is the DECISION the runner
   * makes from it, not the set itself — `isObservationTool`'s own members are
   * pinned in `agent-tool-groups.spec.ts`.
   */
  const observation = new Set([
    'read_current_page',
    'snapshot_page',
    'list_tabs',
    'list_network_requests',
    'screenshot',
    'recognize_image',
  ])
  return {
    runAgentTurn: (...args: unknown[]) => runAgentTurn(...args),
    isObservationTool: (name: string) => observation.has(name),
  }
})
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

  it('reports no answer instead of the narration when the turn ends on a tool call', async () => {
    scriptTurn([
      { type: 'delta', text: 'I will start by taking a snapshot of the page. ' },
      { type: 'tool.start', name: 'snapshot_page' },
    ])
    const result = await runUnattendedPrompt('do it', 'conv', 'readonly')
    expect(result.ok).toBe(false)
    expect(result.answer).not.toMatch(/snapshot of the page/)
    // The narration is not lost — it is in the trace the caller logs.
    expect(result.answer).toMatch(/→ snapshot_page/)
  })

  it('auto-approves an observation but declines a page action', async () => {
    let captured: { confirm?: (name: string) => Promise<boolean> } | undefined
    runAgentTurn.mockImplementation(async (_history: unknown, deps: unknown) => {
      captured = deps as { confirm?: (name: string) => Promise<boolean> }
      return null
    })
    await runUnattendedPrompt('do it', 'conv', 'readonly')
    const confirm = captured?.confirm
    expect(confirm).toBeTypeOf('function')
    await expect(confirm?.('read_current_page')).resolves.toBe(true)
    await expect(confirm?.('snapshot_page')).resolves.toBe(true)
    await expect(confirm?.('click')).resolves.toBe(false)
    await expect(confirm?.('wf_op_forms')).resolves.toBe(false)
  })

  it('still approves everything in full mode', async () => {
    let captured: { confirm?: (name: string) => Promise<boolean> } | undefined
    runAgentTurn.mockImplementation(async (_history: unknown, deps: unknown) => {
      captured = deps as { confirm?: (name: string) => Promise<boolean> }
      return null
    })
    await runUnattendedPrompt('do it', 'conv', 'full')
    await expect(captured?.confirm?.('click')).resolves.toBe(true)
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

  it('names the round cap as the cause when the loop stopped on its budget', async () => {
    // A saved graph gave its AI nodes two tool rounds; both went to `load_tools`
    // and `use_skill`, the loop emitted its cap notice, and the workflow step died
    // as "AI 智能体: 运行失败" with no reason anywhere in the run log.
    scriptTurn([
      { type: 'tool.start', name: 'load_tools' },
      { type: 'tool.result', summary: 'Loaded tools: skills' },
      { type: 'tool.start', name: 'use_skill' },
      { type: 'tool.result', summary: 'Using skill "xiaohongshu-viral-writer"' },
      { type: 'status', text: 'Stopped after 2 tool rounds to avoid a loop.' },
    ])
    const result = await runUnattendedPrompt('do it', 'conv')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Stopped after 2 tool rounds/)
    expect(result.error).toMatch(/tool-round budget/)
  })

  it('names the last tool call when the turn simply ended without an answer', async () => {
    scriptTurn([
      { type: 'tool.start', name: 'snapshot_page' },
      { type: 'tool.result', summary: 'Declined by user' },
    ])
    const result = await runUnattendedPrompt('do it', 'conv', 'readonly')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/snapshot_page/)
  })
})
