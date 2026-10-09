import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentServerMessage } from '../src/lib/messages'
import { runAgentTurn } from '../src/background/agent'
import { streamCompletion } from '../src/lib/llm'
import {
  clearConfirmedWorkflowName,
  loadConfirmedWorkflowName,
  loadGenerationGoal,
  saveConfirmedWorkflowName,
  saveGenerationGoal,
} from '../src/lib/workflow/generation-goal-storage'
import { normalizeGenerationGoalContract } from '../src/lib/workflow/generation-goal'
import { composeWorkflowFromDraft, runOperatorTool } from '../src/background/operator-tool-handler'

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

/** In-memory `chrome.storage.local` double (same shape as other workflow specs). */
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
        remove: vi.fn(async (keys: string | string[]) => {
          const wanted = typeof keys === 'string' ? [keys] : keys
          for (const key of wanted) store.delete(key)
        }),
      },
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('chrome', makeChromeMock())
  getActiveProviderMock.mockResolvedValue({
    apiKey: 'k',
    baseUrl: 'https://x',
    model: 'm',
    label: 'test',
  })
})

let seq = 0
function toolCall(name: string, args: Record<string, unknown>) {
  return {
    id: `c${++seq}`,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  }
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
  name: 'Model Suggested Name',
  summary: 'The success banner is shown after submit.',
  successConditions: [{ kind: 'elementExists', target: { text: 'success' } }],
  requiredCapabilities: ['click', 'element-exists'],
}

describe('user-confirmed workflow name storage', () => {
  it('persists, loads and clears per conversation', async () => {
    const conversationId = 'conv-name-store'
    expect(await loadConfirmedWorkflowName(conversationId)).toBeUndefined()
    await saveConfirmedWorkflowName(conversationId, '  提交报销申请  ')
    expect(await loadConfirmedWorkflowName(conversationId)).toBe('提交报销申请')
    await saveConfirmedWorkflowName(conversationId, '   ')
    expect(await loadConfirmedWorkflowName(conversationId)).toBe('提交报销申请')
    await clearConfirmedWorkflowName(conversationId)
    expect(await loadConfirmedWorkflowName(conversationId)).toBeUndefined()
  })
})

describe('prepare_workflow_goal name precedence', () => {
  it('the user-confirmed name wins over the model-supplied name', async () => {
    const conversationId = `conv-name-confirmed-${Math.random().toString(36).slice(2)}`
    await saveConfirmedWorkflowName(conversationId, '提交报销单')
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('prepare_workflow_goal', goalArgs)],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)
    const history: { role: string; content?: string }[] = [{ role: 'user', content: 'build it' }]
    await runAgentTurn(history as never, deps(conversationId) as never)
    const contract = await loadGenerationGoal(conversationId)
    expect(contract?.name).toBe('提交报销单')
  })

  it('falls back to the model-supplied name when none was confirmed', async () => {
    const conversationId = `conv-name-model-${Math.random().toString(36).slice(2)}`
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('prepare_workflow_goal', goalArgs)],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)
    const history: { role: string; content?: string }[] = [{ role: 'user', content: 'build it' }]
    await runAgentTurn(history as never, deps(conversationId) as never)
    const contract = await loadGenerationGoal(conversationId)
    expect(contract?.name).toBe('Model Suggested Name')
  })
})

describe('composeWorkflowFromDraft name resolution', () => {
  it('replaces the workflow-xxxxxx placeholder with the contract name', async () => {
    const conversationId = `conv-compose-name-${Math.random().toString(36).slice(2)}`
    const out = await runOperatorTool({
      name: 'wf_op_event-click',
      args: { selector: '#go' },
      conversationId,
    })
    expect(out.ok).toBe(true)
    const contract = normalizeGenerationGoalContract({
      version: 1,
      name: 'Scrape Product Prices',
      goalSpec: {
        summary: 'The price table shows at least one row.',
        successConditions: [{ kind: 'elementExists', target: { testId: 'prices' } }],
      },
      requiredCapabilities: ['click'],
    })
    expect(contract).toBeDefined()
    await saveGenerationGoal(conversationId, contract!)
    const composed = await composeWorkflowFromDraft(conversationId, { save: false })
    expect('workflow' in composed).toBe(true)
    if ('workflow' in composed) {
      expect(composed.workflow.name).toBe('Scrape Product Prices')
      expect(composed.workflow.name).not.toMatch(/^workflow-/)
    }
  })
})
