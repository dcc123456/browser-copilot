import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentServerMessage } from '../src/lib/messages'
import {
  advertiseTools,
  armPlanGate,
  buildSystemPrompt,
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
 * turn AND ends plan mode — the conversation arm is cleared, so the next turn
 * starts ungated (the panel unpins the plan skill on approval in parallel).
 * The skill itself is MANUAL-ONLY: the agent cannot load it via `use_skill`,
 * and unattended runs never arm it (they auto-approve instead of stalling).
 */

vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: vi.fn() }
})

const getActiveProviderMock = vi.fn()
const getSkillMock = vi.fn()
const listSkillsMock = vi.fn()
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return {
    ...actual,
    getActiveProvider: (...args: unknown[]) => getActiveProviderMock(...args),
    getSkill: (...args: unknown[]) => getSkillMock(...args),
    listSkills: (...args: unknown[]) => listSkillsMock(...args),
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
  listSkillsMock.mockResolvedValue([])
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

describe('use_skill surface while the plan skill is pinned', () => {
  it('joins the core surface only when planSkillActive is set', () => {
    // Default: on-demand group — the model would have to load_tools first,
    // which never happens mid-plan.
    expect(advertiseTools({ mode: 'full' }).map((tool) => tool.function.name)).not.toContain(
      'use_skill',
    )
    for (const mode of ['semi', 'full', 'readonly', 'workflow'] as const) {
      const names = advertiseTools({ mode, planSkillActive: true }).map(
        (tool) => tool.function.name,
      )
      expect(names, mode).toContain('use_skill')
    }
  })

  it('still honours the user-disabled list and the specialist whitelist', () => {
    const names = advertiseTools({
      mode: 'full',
      planSkillActive: true,
      disabled: new Set(['use_skill']),
    }).map((tool) => tool.function.name)
    expect(names).not.toContain('use_skill')

    const whitelisted = advertiseTools({
      mode: 'full',
      planSkillActive: true,
      allowTools: new Set(['click', 'read_current_page']),
    }).map((tool) => tool.function.name)
    expect(whitelisted).not.toContain('use_skill')
  })

  it('round-0 request of a pinned-plan turn advertises use_skill', async () => {
    const conversationId = `conv-${Math.random().toString(36).slice(2)}`
    getSkillMock.mockResolvedValue({
      id: 'plan-skill-id',
      name: 'plan',
      description: 'Plan before doing.',
      instructions: '# Plan\n\nplan first',
      autoMatch: true,
      createdAt: 0,
      updatedAt: 0,
    })
    streamMock
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)
    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'plan something' },
    ]
    await runAgentTurn(
      history as never,
      deps({ conversationId, skillId: 'plan-skill-id' }) as never,
    )
    const request = streamMock.mock.calls[0]?.[0] as { tools: { function: { name: string } }[] }
    const names = request.tools.map((tool) => tool.function.name)
    expect(names).toContain('use_skill')
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

  it('approval ends plan mode: the next turn starts ungated', async () => {
    const conversationId = `conv-${Math.random().toString(36).slice(2)}`
    armPlanGate(conversationId)
    const turn = (): { history: { role: string; name?: string; content?: string }[] } => {
      const history: { role: string; name?: string; content?: string }[] = [
        { role: 'user', content: 'task' },
      ]
      return { history }
    }

    // Turn 1: plan → approved. Approval also clears the conversation arm.
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
    expect(isPlanGateArmed(conversationId)).toBe(false)

    // Turn 2: a fresh task — plan mode is over, the action goes straight out.
    const second = turn()
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('b1', 'click', {})],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)
    await runAgentTurn(second.history as never, deps({ conversationId }) as never)
    expect(String(toolResult(second.history, 'click')['error'])).not.toContain(
      'Plan-first is active',
    )
  })

  it('refuses an agent-initiated use_skill of the plan skill and arms nothing', async () => {
    const conversationId = `conv-${Math.random().toString(36).slice(2)}`
    // Plan is MANUAL-ONLY: the model cannot pull the gate over itself. The
    // skills group is on-demand in full mode, so the flow loads it first and
    // the refusal fires when use_skill is actually dispatched — before any
    // skill lookup, leaving the arm store untouched.
    listSkillsMock.mockResolvedValue([])
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c0', 'load_tools', { groups: ['skills'] })],
      } as never)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'use_skill', { name: PLAN_SKILL_NAME })],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'task' },
    ]
    await runAgentTurn(history as never, deps({ conversationId }) as never)

    const result = toolResult(history, 'use_skill')
    expect(String(result['error'])).toContain('user-selected only')
    expect(isPlanGateArmed(conversationId)).toBe(false)
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

describe('skill catalogue composition while the plan skill is pinned', () => {
  const planSkill = {
    id: 'builtin-plan',
    name: 'plan',
    description: 'Plan before doing.',
    instructions: '# Plan\n\nplan first',
    autoMatch: true,
    createdAt: 0,
    updatedAt: 0,
  }
  const helperSkill = {
    id: 'skill-helper',
    name: 'captcha-helper',
    description: 'Solve captchas on this site.',
    instructions: 'Read the captcha with recognize_image.',
    autoMatch: true,
    createdAt: 0,
    updatedAt: 0,
  }

  it('keeps the catalogue visible in the system prompt so steps can load skills', () => {
    getSkillMock.mockResolvedValue(planSkill)
    const prompt = buildSystemPrompt({ activeSkill: planSkill, catalogue: [helperSkill], mode: 'full' })
    expect(prompt).toContain('captcha-helper')
    expect(prompt).toContain('use_skill')
    expect(prompt).toContain('## ACTIVE SKILL — APPLY NOW: plan')
  })

  it('still suppresses the catalogue for ordinary pinned skills', () => {
    const prompt = buildSystemPrompt({
      activeSkill: { ...planSkill, name: 'summarise' },
      catalogue: [helperSkill],
      mode: 'full',
    })
    expect(prompt).not.toContain('captcha-helper')
  })

  it('excludes the plan skill itself and the mounted mode skill from the turn catalogue', async () => {
    getSkillMock.mockResolvedValue(planSkill)
    listSkillsMock.mockResolvedValue([planSkill, helperSkill])
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'present_plan', {
          goal: 'g',
          steps: [{ title: 's1' }, { title: 's2' }],
        })],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)
    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'plan something' },
    ]
    const sent: AgentServerMessage[] = []
    await runAgentTurn(
      history as never,
      deps({ conversationId: `conv-${Math.random().toString(36).slice(2)}`, skillId: 'plan-skill-id', send: (m) => sent.push(m) }) as never,
    )
    // The turn's catalogue passed into the prompt never advertises 'plan' itself.
    const promptCall = streamMock.mock.calls[0]?.[0] as { messages: { content: string }[] }
    const system = String(promptCall.messages[0]?.content ?? '')
    expect(system).toContain('## ACTIVE SKILL — APPLY NOW: plan')
    expect(system).toContain('captcha-helper')
  })
})

describe('context compaction hook (runAgentTurn)', () => {
  const PLAN_ARGS = {
    goal: 'g',
    steps: [{ title: 's1' }, { title: 's2' }],
  }
  const usage = (inputTokens: number) => ({
    inputTokens,
    outputTokens: 10,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: inputTokens + 10,
  })

  it('compacts older turns once the reported prompt_tokens cross 80% of 256K', async () => {
    const conversationId = `conv-${Math.random().toString(36).slice(2)}`
    // Three prior turns so compaction has something to fold.
    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'turn A question' },
      { role: 'assistant', content: 'turn A long answer' },
      { role: 'user', content: 'turn B question' },
      { role: 'assistant', content: 'turn B long answer' },
      { role: 'user', content: 'current request' },
    ]
    // Round 0 reports 210k prompt tokens (>= 80% of 256K) and calls a tool.
    // Round 1 then starts with compaction: the summarizer consumes the middle
    // request before the real round-1 request goes out.
    streamMock
      .mockResolvedValueOnce({
        content: '',
        usage: usage(210_000),
        toolCalls: [toolCall('c1', 'present_plan', PLAN_ARGS)],
      } as never)
      .mockResolvedValueOnce({ content: 'SUMMARY TEXT', toolCalls: [] } as never)
      .mockResolvedValueOnce({
        content: 'done',
        usage: usage(4_000),
        toolCalls: [],
      } as never)

    const sent: AgentServerMessage[] = []
    await runAgentTurn(history as never, deps({ conversationId, send: (m) => sent.push(m) }) as never)

    // Status line announced.
    const status = sent.find((m) => m.type === 'status')
    expect(status && 'text' in status && String(status.text)).toMatch(/summar|摘要/)

    // The summarizer received the removed messages' transcript.
    const summarizeCall = streamMock.mock.calls[1]?.[0] as { messages: { content: string }[] }
    expect(String(summarizeCall.messages[1]?.content)).toContain('assistant: turn A long answer')

    // The round-1 request carries the compacted history: old answers gone,
    // user messages and the marker summary present.
    const nextCall = streamMock.mock.calls[2]?.[0] as { messages: { content: string }[] }
    const sent1 = nextCall.messages.map((m) => String(m.content))
    expect(sent1.some((content) => content.includes('[Context compacted]') || content.includes('[上下文已压缩]'))).toBe(true)
    expect(sent1.some((content) => content.includes('turn A long answer'))).toBe(false)
    expect(sent1.some((content) => content.includes('turn A question'))).toBe(true)
    expect(sent1.some((content) => content.includes('turn B long answer'))).toBe(true)
  })

  it('compacts at most once per turn', async () => {
    const conversationId = `conv-${Math.random().toString(36).slice(2)}`
    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'turn A question' },
      { role: 'assistant', content: 'turn A answer' },
      { role: 'user', content: 'turn B question' },
      { role: 'assistant', content: 'turn B answer' },
      { role: 'user', content: 'current request' },
    ]
    streamMock
      .mockResolvedValueOnce({
        content: '',
        usage: usage(250_000),
        toolCalls: [toolCall('c1', 'present_plan', PLAN_ARGS)],
      } as never)
      .mockResolvedValueOnce({ content: '', usage: usage(250_000), toolCalls: [] } as never)
      .mockResolvedValueOnce({
        content: '',
        usage: usage(250_000),
        toolCalls: [toolCall('c2', 'present_plan', PLAN_ARGS)],
      } as never)
      .mockResolvedValueOnce({ content: '', usage: usage(250_000), toolCalls: [] } as never)
      .mockResolvedValueOnce({ content: 'done', usage: usage(4_000), toolCalls: [] } as never)

    const sent: AgentServerMessage[] = []
    await runAgentTurn(history as never, deps({ conversationId, send: (m) => sent.push(m) }) as never)

    const statuses = sent.filter(
      (m) => m.type === 'status' && 'text' in m && /summar|摘要/.test(String(m.text)),
    )
    expect(statuses).toHaveLength(1)
  })
})
