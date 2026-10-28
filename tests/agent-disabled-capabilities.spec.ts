/**
 * Per-node capability switches on the workflow `ai-agent` block: names listed in
 * `disabledSkills` leave the system prompt's skill catalogue and cannot be
 * loaded, and `disabledTools` keeps a tool schema out of the request. The lists
 * are deny lists, so an absent or empty value keeps every capability — the
 * default for old nodes and for tools/skills added later.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentServerMessage } from '../src/lib/messages'
import { runAgentTurn } from '../src/background/agent'
import { streamCompletion } from '../src/lib/llm'

vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: vi.fn() }
})

const getActiveProviderMock = vi.fn()
const getSkillMock = vi.fn()
const findSkillByNameMock = vi.fn()
const listSkillsMock = vi.fn()
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return {
    ...actual,
    getActiveProvider: (...args: unknown[]) => getActiveProviderMock(...args),
    getSkill: (...args: unknown[]) => getSkillMock(...args),
    findSkillByName: (...args: unknown[]) => findSkillByNameMock(...args),
    listSkills: (...args: unknown[]) => listSkillsMock(...args),
  }
})

const captcha = {
  id: 'skill-captcha',
  name: 'captcha-helper',
  description: 'Solve captchas on this site.',
  instructions: 'Read the captcha with recognize_image.',
  autoMatch: true,
  createdAt: 0,
  updatedAt: 0,
}
const writer = {
  id: 'skill-writer',
  name: 'xiaohongshu-writer',
  description: 'Write Xiaohongshu posts.',
  instructions: 'Use a hook and three body blocks.',
  autoMatch: true,
  createdAt: 0,
  updatedAt: 0,
}

beforeEach(() => {
  getActiveProviderMock.mockResolvedValue({
    apiKey: 'k',
    baseUrl: 'https://x',
    model: 'm',
    label: 'test',
  })
  getSkillMock.mockResolvedValue(undefined)
  listSkillsMock.mockResolvedValue([captcha, writer])
  findSkillByNameMock.mockImplementation(
    async (name: string) =>
      [captcha, writer].find((skill) => skill.name.toLowerCase() === name.toLowerCase()) as
        typeof captcha | undefined,
  )
})

const streamMock = vi.mocked(streamCompletion)

afterEach(() => {
  streamMock.mockReset()
})

function deps(toolConfig: { disabledTools: string[]; disabledSkills?: string[] }) {
  return {
    send: (_message: AgentServerMessage): void => {},
    confirm: vi.fn(async () => true),
    conversationId: `conv-${Math.random().toString(36).slice(2)}`,
    getMode: async () => 'full' as const,
    getMaxToolRounds: async () => 6,
    getToolConfig: async () => ({ basePrompt: '', ...toolConfig }),
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    id,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  }
}

function toolResult(history: { role: string; name?: string; content?: string }[], name: string) {
  const entry = [...history].reverse().find((m) => m.role === 'tool' && m.name === name)
  if (!entry) throw new Error(`no tool result for ${name}`)
  return JSON.parse(entry.content ?? '{}') as Record<string, unknown>
}

function requestSystemPrompt(index: number): string {
  const request = streamMock.mock.calls[index]?.[0] as
    { messages?: { role: string; content: string }[] } | undefined
  const system = request?.messages?.[0]
  if (!system) throw new Error(`no system message in request ${index}`)
  return system.content
}

function advertisedNames(index: number): string[] {
  const request = streamMock.mock.calls[index]?.[0]
  if (!request) throw new Error(`no request at index ${index}`)
  return (request.tools ?? []).map((tool) => tool.function.name)
}

/** One completed turn; returns the system prompt the model saw. */
async function promptFor(toolConfig: {
  disabledTools: string[]
  disabledSkills?: string[]
}): Promise<string> {
  streamMock.mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)
  await runAgentTurn([{ role: 'user', content: 'hi' }] as never, deps(toolConfig) as never)
  return requestSystemPrompt(0)
}

describe('disabled skills leave the model request', () => {
  it('lists every saved skill when nothing is switched off', async () => {
    const prompt = await promptFor({ disabledTools: [] })
    expect(prompt).toContain('## Available skills')
    expect(prompt).toContain(captcha.name)
    expect(prompt).toContain(writer.name)
  })

  it('drops a switched-off skill from the catalogue, case-insensitively', async () => {
    const prompt = await promptFor({
      disabledTools: [],
      disabledSkills: ['  XIAOHONGSHU-WRITER '],
    })
    expect(prompt).toContain(captcha.name)
    expect(prompt).not.toContain(writer.name)
  })

  it('drops the whole catalogue when use_skill itself is disabled', async () => {
    // The catalogue is instruction prose that only earns its tokens if the
    // model can act on it. With the loader switched off it is pure cost.
    const prompt = await promptFor({ disabledTools: ['use_skill'] })
    expect(prompt).not.toContain('## Available skills')
    expect(prompt).not.toContain(captcha.name)
    expect(prompt).not.toContain(writer.name)
  })

  it('refuses to load a switched-off skill even when the schema is advertised', async () => {
    // `use_skill` is a core tool, so the node's switches cannot remove its
    // schema; a stale or hallucinated call must still be refused.
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'load_tools', { groups: ['skills'] })],
      } as never)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c2', 'use_skill', { name: 'captcha-helper' })],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'solve it' },
    ]
    await runAgentTurn(
      history as never,
      deps({ disabledTools: [], disabledSkills: ['captcha-helper'] }) as never,
    )

    const result = toolResult(history, 'use_skill')
    expect(String(result['error'])).toContain('disabled for this block')
    expect(result['instructions']).toBeUndefined()
    expect(findSkillByNameMock).not.toHaveBeenCalled()
  })

  it('leaves switched-off names out of the "available skills" hint', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'load_tools', { groups: ['skills'] })],
      } as never)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c2', 'use_skill', { name: 'no-such-skill' })],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'solve it' },
    ]
    await runAgentTurn(
      history as never,
      deps({ disabledTools: [], disabledSkills: ['captcha-helper'] }) as never,
    )

    const result = toolResult(history, 'use_skill')
    expect(result['available']).toEqual([writer.name])
  })
})

describe('disabled tools leave the model request', () => {
  it('keeps a switched-off tool out of the advertised schemas', async () => {
    streamMock.mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)
    await runAgentTurn(
      [{ role: 'user', content: 'hi' }] as never,
      deps({ disabledTools: ['click', 'screenshot'] }) as never,
    )
    const names = advertisedNames(0)
    expect(names).not.toContain('click')
    expect(names).not.toContain('screenshot')
    expect(names).toContain('snapshot_page')
  })
})
