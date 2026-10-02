import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentServerMessage } from '../src/lib/messages'
import { runAgentTurn } from '../src/background/agent'
import { streamCompletion } from '../src/lib/llm'
import {
  clearGenerationGoal,
  loadGenerationGoal,
} from '../src/lib/workflow/generation-goal-storage'
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
  // Named by the words on it, not by a test hook: a goal row whose only locator is
  // a selector or test id is invented and gets refused at this seam.
  successConditions: [{ kind: 'elementExists', target: { text: 'success' } }],
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
    { ...goalArgs, successConditions: [{ kind: 'urlContains', value: '/publish/publish' }] },
    {
      ...goalArgs,
      successConditions: [
        { kind: 'urlContains', value: '/publish/publish' },
        { kind: 'urlMatches', value: '.*/publish/.*' },
      ],
    },
  ])('refuses a goal nothing on the page can prove: %j', async (bad) => {
    const conversationId = `conv-v07-${Math.random().toString(36).slice(2)}`
    streamMock
      .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('prepare_workflow_goal', bad)] } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)
    const history: { role: string; name?: string; content?: string }[] = [{ role: 'user', content: 'go' }]
    await runAgentTurn(history as never, deps(conversationId) as never)
    const payload = JSON.parse(history.find((m) => m.role === 'tool')!.content ?? '{}')
    expect(JSON.stringify(payload)).toContain('error')
    // Nothing may be remembered for the next round: a half-valid contract would
    // unlock the operators and ship a graph that cannot certify itself.
    expect(await loadGenerationGoal(conversationId)).toBeUndefined()
  })
})
describe('V07c a proof that does not name its element is refused', () => {
  // Rounds 26 / 43 / 44 each replayed every step and then failed their OWN goal on
  // `.publishBtn`, testid `draft-saved` and `.note-item` — locators the model was
  // never shown, so the check read false whatever the run did. The one L3 pass
  // rested on `{text: "草稿箱"}`.
  it.each([
    { kind: 'elementExists', target: { selector: '.publish-container, .draft-list' } },
    { kind: 'elementText', target: { testId: 'draft-saved' }, expected: '草稿', match: 'contains' },
    // Round 50 is the other half: 33/33 steps covered, and the proof «元素存在 button»
    // was satisfied by any button on the page. A role narrows a name; alone it is a
    // vacuous proof, which no amount of clean replay turns into evidence.
    { kind: 'elementExists', target: { role: 'button' } },
  ])('refuses %j and remembers no contract', async (row) => {
    const conversationId = `conv-v07c-${Math.random().toString(36).slice(2)}`
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          toolCall('prepare_workflow_goal', {
            ...goalArgs,
            successConditions: [{ kind: 'urlContains', value: '/publish/publish' }, row],
          }),
        ],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)
    const history: { role: string; name?: string; content?: string }[] = [{ role: 'user', content: 'go' }]
    await runAgentTurn(history as never, deps(conversationId) as never)
    expect(JSON.stringify(history.filter((m) => m.role === 'tool').at(-1))).toContain(
      'does not name its element in the words',
    )
    expect(await loadGenerationGoal(conversationId)).toBeUndefined()
  })

  it('accepts the same element named by its words, with the selector as company', async () => {
    const conversationId = `conv-v07c-ok-${Math.random().toString(36).slice(2)}`
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          toolCall('prepare_workflow_goal', {
            ...goalArgs,
            successConditions: [
              { kind: 'elementVisible', target: { selector: '.btn-text', text: '暂存离开' } },
            ],
          }),
        ],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)
    const history: { role: string; name?: string; content?: string }[] = [{ role: 'user', content: 'go' }]
    await runAgentTurn(history as never, deps(conversationId) as never)
    expect(await loadGenerationGoal(conversationId)).toBeDefined()
  })
})
describe('V07b URL rows ride along when real proof is present', () => {
  const conversationId = `conv-v07b-${Math.random().toString(36).slice(2)}`
  beforeEach(async () => {
    await clearGenerationGoal(conversationId)
  })
  it('accepts a goal with one after-the-action condition, URL row and all', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          toolCall('prepare_workflow_goal', {
            ...goalArgs,
            successConditions: [
              { kind: 'urlContains', value: '/publish/publish' },
              { kind: 'elementText', target: { text: '草稿' }, expected: '草稿' },
            ],
          }),
        ],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)
    const history: { role: string; name?: string; content?: string }[] = [{ role: 'user', content: 'go' }]
    await runAgentTurn(history as never, deps(conversationId) as never)
    const goal = await loadGenerationGoal(conversationId)
    expect(goal?.goalSpec.successConditions.map((c) => c.kind)).toEqual([
      'urlContains',
      'elementText',
    ])
  })
})