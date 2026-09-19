import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentServerMessage } from '../src/lib/messages'
import {
  advertiseTools,
  armPlanGate,
  isPlanGateArmed,
  modeAutoApproves,
  PLAN_SKILL_NAME,
  planGateBlocks,
  runAgentTurn,
  type PlanGate,
} from '../src/background/agent'
import { streamCompletion } from '../src/lib/llm'

/**
 * The plan skill's hard gate (`present_plan`): while the plan skill governs a
 * turn and the plan is unapproved, every page action and workflow operator is
 * refused; reads stay available. Approval opens the gate for the rest of the
 * turn; the next turn re-arms it (one user message = one task = one plan).
 * Unattended runs never arm it and auto-approve the plan instead of stalling.
 */

vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: vi.fn() }
})

const getActiveProviderMock = vi.fn()
const getSkillMock = vi.fn()
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return {
    ...actual,
    getActiveProvider: (...args: unknown[]) => getActiveProviderMock(...args),
    getSkill: (...args: unknown[]) => getSkillMock(...args),
  }
})

beforeEach(() => {
  getActiveProviderMock.mockResolvedValue({
    apiKey: 'k',
    baseUrl: 'https://x',
    model: 'm',
    label: 'test',
  })
  getSkillMock.mockResolvedValue(undefined)
})

const streamMock = vi.mocked(streamCompletion)

afterEach(() => {
  streamMock.mockReset()
})

function deps(
  overrides: Partial<Parameters<typeof runAgentTurn>[1]> & { conversationId?: string } = {},
) {
  const conversationId =
    overrides.conversationId ?? `conv-${Math.random().toString(36).slice(2)}`
  return {
    send: (_message: AgentServerMessage): void => {},
    confirm: vi.fn(async () => true),
    askUser: vi.fn(async ({ answer }: { answer: string }) => ({ answer, cancelled: false })),
    planDecision: vi.fn(async () => ({ approved: true })),
    conversationId,
    getMode: async () => 'full' as const,
    getMaxToolRounds: async () => 6,
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
  occurrence = 'last',
): Record<string, unknown> {
  const matches = history.filter((m) => m.role === 'tool' && m.name === name)
  const entry = occurrence === 'first' ? matches[0] : matches.at(-1)
  if (!entry) throw new Error(`no tool result for ${name}`)
  return JSON.parse(entry.content ?? '{}') as Record<string, unknown>
}

const PLAN: PlanGate = { armed: true, approved: false, split: false }
const APPROVED: PlanGate = { armed: true, approved: true, split: false }

describe('planGateBlocks (pure predicate)', () => {
  it('does nothing when the gate is absent or disarmed', () => {
    expect(planGateBlocks(undefined, 'click')).toBe(false)
    expect(planGateBlocks({ ...PLAN, armed: false }, 'click')).toBe(false)
  })

  it('blocks page actions and workflow operators while unapproved', () => {
    for (const name of ['click', 'fill', 'open_url', 'tab_switch', 'run_plan', 'save_local']) {
      expect(planGateBlocks(PLAN, name), name).toBe(true)
    }
    expect(planGateBlocks(PLAN, 'wf_op_event-click')).toBe(true)
    expect(planGateBlocks(PLAN, 'wf_op_new-tab')).toBe(true)
  })

  it('keeps reads and the research-phase image tools available', () => {
    for (const name of [
      'read_current_page',
      'snapshot_page',
      'list_tabs',
      'list_network_requests',
      'screenshot',
      'recognize_image',
      'present_plan',
      'ask_user',
      'load_tools',
      'use_skill',
      'use_operators',
      'get_my_profile',
    ]) {
      expect(planGateBlocks(PLAN, name), name).toBe(false)
    }
  })

  it('stops blocking once the plan is approved', () => {
    expect(planGateBlocks(APPROVED, 'click')).toBe(false)
    expect(planGateBlocks(APPROVED, 'wf_op_forms')).toBe(false)
  })
})

describe('present_plan tool surface', () => {
  it('is auto-approved in every interactive mode (it is a UI hand-off)', () => {
    for (const mode of ['semi', 'full', 'workflow', 'readonly'] as const) {
      expect(modeAutoApproves(mode, 'present_plan'), mode).toBe(true)
    }
  })

  it('is advertised in every non-chat mode without any group load', () => {
    for (const mode of ['semi', 'full', 'readonly', 'workflow'] as const) {
      const names = advertiseTools({ mode }).map((tool) => tool.function.name)
      expect(names, mode).toContain('present_plan')
    }
    expect(advertiseTools({ mode: 'chat' })).toEqual([])
  })

  it('releases compose_workflow only for an approved multi-workflow split', () => {
    const names = (options: Parameters<typeof advertiseTools>[0]) =>
      advertiseTools(options).map((tool) => tool.function.name)
    expect(names({ mode: 'workflow' })).not.toContain('compose_workflow')
    expect(names({ mode: 'full', planSplitApproved: true })).not.toContain('compose_workflow')
    expect(names({ mode: 'workflow', planSplitApproved: true })).toContain('compose_workflow')
  })
})

describe('plan gate across a turn', () => {
  it('refuses a page action and then unlocks after an approved plan', async () => {
    const conversationId = `conv-${Math.random().toString(36).slice(2)}`
    armPlanGate(conversationId)
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'click', {})],
      } as never)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          toolCall('c2', 'present_plan', {
            goal: '搜索 iPhone 15 并打开第一个结果',
            steps: [
              { title: 'fill → 搜索框输入「iPhone 15」' },
              { title: 'click → 搜索按钮 → 出现结果列表' },
            ],
            risks: '无',
          }),
        ],
      } as never)
      .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('c3', 'click', {})] } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: '帮我搜一下' },
    ]
    await runAgentTurn(history as never, deps({ conversationId }) as never)

    const blocked = toolResult(history, 'click', 'first') // first click (c1)
    expect(String(blocked['error'])).toContain('Plan-first is active')

    const submitted = toolResult(history, 'present_plan')
    expect(submitted['approved']).toBe(true)
    expect(submitted['ok']).toBe(true)

    // The second click reached executeTool (its "needs an element" argument
    // error, not the plan gate) — the gate opened on approval.
    const afterApproval = toolResult(history, 'click', 'last')
    expect(String(afterApproval['error'])).not.toContain('Plan-first is active')
    expect(String(afterApproval['error'])).toContain('needs an element')
  })

  it('feeds a rejection back with the user feedback for revision', async () => {
    const conversationId = `conv-${Math.random().toString(36).slice(2)}`
    armPlanGate(conversationId)
    const planDecision = vi.fn(async () => ({ approved: false, feedback: '不要打开新标签页' }))
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          toolCall('c1', 'present_plan', {
            goal: 'g',
            steps: [{ title: 'a' }, { title: 'b' }],
          }),
        ],
      } as never)
      .mockResolvedValueOnce({ content: 'revising', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'task' },
    ]
    await runAgentTurn(history as never, deps({ conversationId, planDecision }) as never)

    const result = toolResult(history, 'present_plan')
    expect(result['approved']).toBe(false)
    expect(String(result['feedback'])).toContain('不要打开新标签页')
    expect(String(result['error'])).toContain('present_plan again')
  })

  it('validates the plan shape before showing anything to the user', async () => {
    const planDecision = vi.fn(async () => ({ approved: true }))
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'present_plan', { goal: 'g', steps: [{ title: 'only one' }] })],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'task' },
    ]
    await runAgentTurn(history as never, deps({ planDecision }) as never)

    const result = toolResult(history, 'present_plan')
    expect(String(result['error'])).toContain('requires "goal"')
    expect(planDecision).not.toHaveBeenCalled()
  })

  it('re-arms on the next turn of the same conversation (one plan per task)', async () => {
    const conversationId = `conv-${Math.random().toString(36).slice(2)}`
    armPlanGate(conversationId)
    const turn = (): { history: { role: string; name?: string; content?: string }[] } => {
      const history: { role: string; name?: string; content?: string }[] = [
        { role: 'user', content: 'task' },
      ]
      return { history }
    }

    // Turn 1: plan → approved.
    const first = turn()
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          toolCall('a1', 'present_plan', { goal: 'g', steps: [{ title: 'a' }, { title: 'b' }] }),
        ],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)
    await runAgentTurn(first.history as never, deps({ conversationId }) as never)
    expect(toolResult(first.history, 'present_plan')['approved']).toBe(true)

    // Turn 2: a fresh task — the gate is armed again and blocks the action.
    const second = turn()
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('b1', 'click', {})],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)
    await runAgentTurn(second.history as never, deps({ conversationId }) as never)
    expect(String(toolResult(second.history, 'click')['error'])).toContain('Plan-first is active')
  })

  it('never arms for an unattended run: actions pass and the plan auto-approves', async () => {
    const conversationId = `conv-${Math.random().toString(36).slice(2)}`
    armPlanGate(conversationId) // leftover from a previous panel session
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'click', {})],
      } as never)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          toolCall('c2', 'present_plan', { goal: 'g', steps: [{ title: 'a' }, { title: 'b' }] }),
        ],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'task' },
    ]
    await runAgentTurn(history as never, deps({ conversationId, planDecision: undefined }) as never)

    // No planDecision dep → no interactive user → the gate never armed, so the
    // click reached executeTool's own argument validation.
    expect(String(toolResult(history, 'click')['error'])).not.toContain('Plan-first is active')
    const submitted = toolResult(history, 'present_plan')
    expect(submitted['approved']).toBe(true)
    expect(submitted['auto']).toBe(true)
  })

  it('arms from a pinned plan skill (deps.skillId)', async () => {
    getSkillMock.mockImplementation(async (id: string) =>
      id === 'plan-skill-id'
        ? {
            id: 'plan-skill-id',
            name: PLAN_SKILL_NAME,
            description: 'plan-first',
            instructions: 'plan',
            autoMatch: true,
            createdAt: 0,
            updatedAt: 0,
          }
        : undefined,
    )
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'click', {})],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'task' },
    ]
    await runAgentTurn(
      history as never,
      deps({ conversationId: `conv-${Math.random().toString(36).slice(2)}`, skillId: 'plan-skill-id' }) as never,
    )
    expect(String(toolResult(history, 'click')['error'])).toContain('Plan-first is active')
  })

  it('records that the conversation is plan-gated when the plan skill is loaded', () => {
    const conversationId = `conv-${Math.random().toString(36).slice(2)}`
    expect(isPlanGateArmed(conversationId)).toBe(false)
    armPlanGate(conversationId)
    expect(isPlanGateArmed(conversationId)).toBe(true)
  })
})
