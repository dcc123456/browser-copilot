import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentServerMessage } from '../src/lib/messages'
import { runAgentTurn } from '../src/background/agent'
import { streamCompletion } from '../src/lib/llm'
import { clearGenerationGoal } from '../src/lib/workflow/generation-goal-storage'
vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: vi.fn() }
})
const getActiveProviderMock = vi.fn()
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return {
    ...actual,
    getActiveProvider: (...args: unknown[]) => getActiveProviderMock(...args),
    listAgents: vi.fn().mockResolvedValue([]),
    listSkills: vi.fn().mockResolvedValue([]),
  }
})
const streamMock = vi.mocked(streamCompletion)
function makeChromeMock() {
  const store = new Map<string, unknown>()
  return {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const wanted = typeof keys === 'string' ? [keys] : keys
          const out: Record<string, unknown> = {}
          for (const key of wanted) if (store.has(key)) out[key] = store.get(key)
          return out
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value)
        }),
      },
    },
  }
}
beforeEach(() => {
  vi.stubGlobal('chrome', makeChromeMock())
  getActiveProviderMock.mockResolvedValue({
    apiKey: 'k', baseUrl: 'https://x', model: 'm', label: 'test',
  })
})
let seq = 0
function toolCall(name: string, args: Record<string, unknown>) {
  return { id: `c${++seq}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }
}
function deps(conversationId: string) {
  return {
    send: (_message: AgentServerMessage): void => {},
    confirm: vi.fn(async () => true),
    conversationId,
    getMode: async () => 'workflow' as const,
    getMaxToolRounds: async () => 6,
    getToolConfig: async () => ({ disabledTools: [], basePrompt: '' }),
  }
}
const goalArgs = {
  summary: 'The success banner is shown after submit.',
  successConditions: [{ kind: 'elementExists', target: { testId: 'success' } }],
  requiredCapabilities: ['click', 'element-exists'],
}
describe('V05 no wf_op execution before a goal exists', () => {
  const conversationId = `conv-v05-${Math.random().toString(36).slice(2)}`
  beforeEach(async () => { await clearGenerationGoal(conversationId) })
  it('rejects the operator with a clear reason and records no node', async () => {
    streamMock
      .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('wf_op_event-click', { selector: '#go' })] } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)
    const history: { role: string; name?: string; content?: string }[] = [{ role: 'user', content: 'do it' }]
    await runAgentTurn(history as never, deps(conversationId) as never)
    const toolMsg = history.find((m) => m.role === 'tool')!
    const payload = JSON.parse(toolMsg.content ?? '{}') as { error?: string }
    expect(payload.error).toContain('prepare_workflow_goal')
  })
})
describe('V06 prepare_workflow_goal establishes the goal', () => {
  const conversationId = `conv-v06-${Math.random().toString(36).slice(2)}`
  beforeEach(async () => { await clearGenerationGoal(conversationId) })
  it('stores the contract and it is readable by later dispatch', async () => {
    streamMock
      .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('prepare_workflow_goal', goalArgs)] } as never)
      .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('find_workflow_operators', { stepIntent: 'click the submit button' })] } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)
    const history: { role: string; name?: string; content?: string }[] = [{ role: 'user', content: 'build it' }]
    await runAgentTurn(history as never, deps(conversationId) as never)
    const findPayload = history.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content ?? '{}'))
    const last = findPayload.at(-1)!
    expect(last.activated.length).toBeGreaterThan(0)
  })
})
describe('V07 non-verifiable goals are rejected', () => {
  it.each([
    { ...goalArgs, successConditions: [] },
  ])('refuses an empty success-condition list', async (bad) => {
    const conversationId = `conv-v07-${Math.random().toString(36).slice(2)}`
    streamMock
      .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('prepare_workflow_goal', bad)] } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)
    const history: { role: string; name?: string; content?: string }[] = [{ role: 'user', content: 'go' }]
    await runAgentTurn(history as never, deps(conversationId) as never)
    const payload = JSON.parse(history.find((m) => m.role === 'tool')!.content ?? '{}')
    expect(JSON.stringify(payload)).toContain('error')
  })
})