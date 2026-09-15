import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentServerMessage } from '../src/lib/messages'
import { runAgentTurn } from '../src/background/agent'
import { streamCompletion } from '../src/lib/llm'
import { truncateSubAgentSummary } from '../src/lib/agents'
import type { Agent } from '../src/lib/types'

/**
 * Supervisor/specialist orchestration: the code-level gates (small-task
 * refusal without any sub-agent LLM call, tool-whitelist clamp, hard summary
 * truncation, per-turn delegation budget, same-target retry cap) and the
 * wiring (supervisor prompt section; sub-agent isolation and recursion
 * guard).
 */

vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: vi.fn() }
})

const getActiveProviderMock = vi.fn()
const listAgentsMock = vi.fn()
const listSkillsMock = vi.fn()
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return {
    ...actual,
    getActiveProvider: (...args: unknown[]) => getActiveProviderMock(...args),
    listAgents: (...args: unknown[]) => listAgentsMock(...args),
    listSkills: (...args: unknown[]) => listSkillsMock(...args),
  }
})

const streamMock = vi.mocked(streamCompletion)

function specialist(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a-search',
    name: 'search-expert',
    role: 'specialist',
    domain: 'search',
    delegationHint: 'Finds sources.',
    instructions: 'Search and report.',
    tools: ['click'],
    skillNames: [],
    delegatable: false,
    maxRounds: 8,
    createdAt: 0,
    updatedAt: 0,
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

function deps(overrides: Partial<Parameters<typeof runAgentTurn>[1]> = {}) {
  return {
    send: (_message: AgentServerMessage): void => {},
    confirm: vi.fn(async () => true),
    conversationId: `conv-${Math.random().toString(36).slice(2)}`,
    getMode: async () => 'full' as const,
    getMaxToolRounds: async () => 6,
    getToolConfig: async () => ({ disabledTools: [], basePrompt: '' }),
    enableDelegation: true,
    ...overrides,
  }
}

function delegateArgs(agent: Agent, task: string, extra: Record<string, unknown> = {}) {
  return { agent: agent.name, task, ...extra }
}

function delegateResults(history: { role: string; name?: string; content?: string }[]) {
  return history
    .filter((m) => m.role === 'tool' && m.name === 'delegate_to_agent')
    .map((m) => JSON.parse(m.content ?? '{}') as Record<string, unknown>)
}

function advertisedNames(requestIndex: number): string[] {
  const request = streamMock.mock.calls[requestIndex]?.[0]
  if (!request) throw new Error(`no request at index ${requestIndex}`)
  return (request.tools ?? []).map((tool) => tool.function.name)
}

const LONG_TASK = `Research this properly: ${'context '.repeat(30)} deliver a list.`

beforeEach(() => {
  getActiveProviderMock.mockResolvedValue({
    apiKey: 'k',
    baseUrl: 'https://x',
    model: 'm',
    label: 'test',
  })
  listAgentsMock.mockResolvedValue([
    {
      id: 'builtin-agent-supervisor',
      name: 'supervisor',
      role: 'supervisor',
      domain: 'custom',
      delegationHint: '',
      instructions: 'You are the supervisor.',
      tools: [],
      skillNames: [],
      delegatable: true,
      maxRounds: 8,
      createdAt: 0,
      updatedAt: 0,
    } satisfies Agent,
    specialist(),
    specialist({
      id: 'a-copy',
      name: 'copywriter',
      domain: 'writing',
      delegationHint: 'Writes.',
      tools: ['save_local'],
    }),
  ])
  listSkillsMock.mockResolvedValue([])
})

afterEach(() => {
  streamMock.mockReset()
})

describe('supervisor prompt wiring', () => {
  it('appends the specialist catalogue when delegation is enabled', async () => {
    streamMock
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)
    await runAgentTurn([{ role: 'user', content: 'hi' }], deps() as never)
    const messages = streamMock.mock.calls[0]![0].messages as { role: string; content: string }[]
    const system = messages[0]!.content
    expect(system).toContain('Specialist agents you can delegate')
    expect(system).toContain('search-expert: Finds sources.')
  })

  it('omits the delegation section without enableDelegation', async () => {
    streamMock.mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)
    await runAgentTurn(
      [{ role: 'user', content: 'hi' }],
      deps({ enableDelegation: false }) as never,
    )
    const messages = streamMock.mock.calls[0]![0].messages as { role: string; content: string }[]
    expect(messages[0]!.content).not.toContain('delegate')
  })
})

describe('gate 2 — small-task refusal costs no sub-agent LLM call', () => {
  it('refuses a tiny task whose specialist adds no tool, with zero new completions', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          toolCall('c1', 'delegate_to_agent', delegateArgs(specialist(), 'tiny task')),
        ],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'do a tiny thing' },
    ]
    await runAgentTurn(history as never, deps() as never)

    const [result] = delegateResults(history)
    expect(result!.status).toBe('refused')
    expect(String(result!.reason)).toMatch(/small/)
    // Exactly the supervisor's two rounds — the sub-agent never made a call.
    expect(streamMock).toHaveBeenCalledTimes(2)
  })
})

describe('gate 3 — delegation budget', () => {
  it('starts four delegations then refuses the fifth', async () => {
    // save_local is NOT in the supervisor's advertised set, so all five tasks
    // clear the small-task overlap gate; only the per-turn count stops them.
    const agent = specialist({ name: 'copywriter', tools: ['save_local'] })
    const calls = Array.from({ length: 5 }, (_unused, i) =>
      toolCall(`c${i}`, 'delegate_to_agent', delegateArgs(agent, `${LONG_TASK} #${i}`)),
    )
    streamMock
      .mockResolvedValueOnce({ content: '', toolCalls: calls } as never)
      // Four real sub-agent turns.
      .mockResolvedValueOnce({ content: 'r1', toolCalls: [] } as never)
      .mockResolvedValueOnce({ content: 'r2', toolCalls: [] } as never)
      .mockResolvedValueOnce({ content: 'r3', toolCalls: [] } as never)
      .mockResolvedValueOnce({ content: 'r4', toolCalls: [] } as never)
      // Supervisor integrates.
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'five big jobs' },
    ]
    await runAgentTurn(history as never, deps() as never)

    const results = delegateResults(history)
    expect(results).toHaveLength(5)
    expect(results.slice(0, 4).every((r) => r.status === 'completed')).toBe(true)
    expect(results[4]!.status).toBe('refused')
    expect(String(results[4]!.reason)).toMatch(/budget exhausted/)
    // 1 supervisor + 4 sub-agent rounds + 1 integration round.
    expect(streamMock).toHaveBeenCalledTimes(6)
  })
})

describe('sub-agent execution', () => {
  const longTask = LONG_TASK

  it('runs the specialist with a whitelist-clamped tool set and isolated id', async () => {
    streamMock
      // 0: supervisor delegates
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          toolCall('c1', 'delegate_to_agent', delegateArgs(specialist(), longTask)),
        ],
      } as never)
      // 1: the sub-agent's own turn — whitelisted tools only
      .mockResolvedValueOnce({ content: 'report', toolCalls: [] } as never)
      // 2: supervisor integrates
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'big research job' },
    ]
    const d = deps()
    await runAgentTurn(history as never, d as never)

    const names = advertisedNames(1)
    expect(names).toContain('click')
    expect(names).toContain('load_tools')
    // Recursion guard: the delegate group is never advertised to a specialist.
    expect(names).not.toContain('delegate_to_agent')
    // A core tool outside the whitelist is withheld.
    expect(names).not.toContain('run_javascript')
    expect(names).not.toContain('snapshot_page')
    // Isolated, namespaced conversation for the group store.
    expect(streamMock.mock.calls[1]![0]).toBeTruthy()

    const [result] = delegateResults(history)
    expect(result!.status).toBe('completed')
    expect(result!.summary).toBe('report')
    expect(result!.rounds).toBe(0)
  })

  it('hard-truncates the returned summary and never streams it to the supervisor', async () => {
    const longReport = `x`.repeat(3000)
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          toolCall('c1', 'delegate_to_agent', delegateArgs(specialist({ tools: ['save_local'], name: 'copywriter' }), 'write it')),
        ],
      } as never)
      .mockResolvedValueOnce({ content: longReport, toolCalls: [] } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'write something long' },
    ]
    const sent: AgentServerMessage[] = []
    await runAgentTurn(
      history as never,
      deps({ send: (m) => sent.push(m) }) as never,
    )

    const [result] = delegateResults(history)
    expect(result!.status).toBe('completed')
    expect(String(result!.summary).length).toBeLessThan(1300)
    expect(String(result!.summary)).toContain('truncated')
    // The sub-agent's prose must never be forwarded as deltas.
    expect(sent.filter((m) => m.type === 'delta')).toHaveLength(0)
  })

  it('retries the same agent+task at most once', async () => {
    const args = delegateArgs(specialist({ tools: ['save_local'] }), longTask)
    streamMock
      // Supervisor asks three identical delegations at once.
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          toolCall('c1', 'delegate_to_agent', args),
          toolCall('c2', 'delegate_to_agent', args),
          toolCall('c3', 'delegate_to_agent', args),
        ],
      } as never)
      // First two run real sub-agent turns; the third is refused.
      .mockResolvedValueOnce({ content: 'r1', toolCalls: [] } as never)
      .mockResolvedValueOnce({ content: 'r2', toolCalls: [] } as never)
      // Supervisor integrates.
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'run it thrice' },
    ]
    await runAgentTurn(history as never, deps() as never)

    const results = delegateResults(history)
    expect(results.map((r) => r.status)).toEqual(['completed', 'completed', 'refused'])
    expect(String(results[2]!.reason)).toMatch(/already delegated/)
  })

  it('fails cleanly on an unknown agent name', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          toolCall('c1', 'delegate_to_agent', { agent: 'ghost', task: longTask }),
        ],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'use the ghost' },
    ]
    await runAgentTurn(history as never, deps() as never)

    const [result] = delegateResults(history)
    expect(result!.status).toBe('failed')
    expect(String(result!.error)).toContain('No specialist agent named "ghost"')
    expect(String(result!.error)).toContain('search-expert')
    expect(streamMock).toHaveBeenCalledTimes(2)
  })
})

describe('unattended runs', () => {
  it('refuses delegation even if the group was loaded', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          toolCall('c1', 'delegate_to_agent', delegateArgs(specialist(), LONG_TASK)),
        ],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'scheduled task' },
    ]
    await runAgentTurn(
      history as never,
      deps({ enableDelegation: false }) as never,
    )

    const [result] = delegateResults(history)
    expect(result!.status).toBe('failed')
    expect(String(result!.error)).toMatch(/not available/i)
  })
})

describe('truncateSubAgentSummary', () => {
  it('is the single hard cap implementation', () => {
    expect(truncateSubAgentSummary('x'.repeat(5000)).length).toBeLessThan(1300)
  })
})
