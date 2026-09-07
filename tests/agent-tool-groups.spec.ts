import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentServerMessage } from '../src/lib/messages'
import { advertiseTools, runAgentTurn, TOOL_GROUPS } from '../src/background/agent'
import { streamCompletion } from '../src/lib/llm'

/**
 * On-demand tool groups: a fresh conversation advertises only the core set +
 * the load_tools loader; a load_tools call widens the advertised set from the
 * next round on; calls into unloaded groups steer the model to the loader
 * instead of executing.
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

function deps(overrides: Partial<Parameters<typeof runAgentTurn>[1]> = {}) {
  return {
    send: (_message: AgentServerMessage): void => {},
    confirm: vi.fn(async () => true),
    conversationId: `conv-${Math.random().toString(36).slice(2)}`,
    getMode: async () => 'full' as const,
    getMaxToolRounds: async () => 6,
    getToolConfig: async () => ({ disabledTools: [], basePrompt: '' }),
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

function advertisedNames(requestIndex: number): string[] {
  const request = streamMock.mock.calls[requestIndex]?.[0]
  if (!request) throw new Error(`no request at index ${requestIndex}`)
  return (request.tools ?? []).map((tool) => tool.function.name)
}

function toolResult(history: { role: string; name?: string; content?: string }[], name: string) {
  const entry = [...history].reverse().find((m) => m.role === 'tool' && m.name === name)
  if (!entry) throw new Error(`no tool result for ${name}`)
  return JSON.parse(entry.content ?? '{}') as Record<string, unknown>
}

afterEach(() => {
  streamMock.mockReset()
})

describe('advertiseTools', () => {
  it('advertises core tools + load_tools, never group tools, before loading', () => {
    const names = advertiseTools({ mode: 'full' }).map((tool) => tool.function.name)
    expect(names).toContain('snapshot_page')
    expect(names).toContain('load_tools')
    for (const group of Object.values(TOOL_GROUPS)) {
      for (const name of group) expect(names).not.toContain(name)
    }
  })

  it('widens the set once a group is loaded', () => {
    const names = advertiseTools({ mode: 'full', loadedGroups: new Set(['tabs']) }).map(
      (tool) => tool.function.name,
    )
    for (const name of TOOL_GROUPS.tabs!) expect(names).toContain(name)
    expect(names).not.toContain('save_local')
  })

  it('still applies read-only and disabled filtering to loaded groups', () => {
    const names = advertiseTools({
      mode: 'readonly',
      loadedGroups: new Set(['tabs', 'data']),
    }).map((tool) => tool.function.name)
    expect(names).toContain('list_tabs') // read-only nav tool
    expect(names).not.toContain('tab_new') // ACTION_TOOLS
    expect(names).not.toContain('save_local') // ACTION_TOOLS
    // Non-action group tools keep the pre-existing read-only semantics.
    expect(names).toContain('get_secret')
    expect(names).toContain('load_tools') // pure bookkeeping, not an action
  })

  it('advertises nothing in chat mode', () => {
    expect(advertiseTools({ mode: 'chat' })).toEqual([])
  })
})

describe('load_tools round trip', () => {
  it('loads a group mid-turn and advertises it on the next round', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'load_tools', { groups: ['tabs'] })],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'open a new tab' },
    ]
    const d = deps()
    await runAgentTurn(history as never, d as never)

    const result = toolResult(history, 'load_tools')
    expect(result.loaded).toEqual(['tabs'])
    expect(advertisedNames(0)).not.toContain('tab_new')
    expect(advertisedNames(1)).toContain('tab_new')
  })

  it('refuses an unloaded group tool with a load hint instead of executing', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'save_local', { content: 'x' })],
      } as never)
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'save this' },
    ]
    await runAgentTurn(history as never, deps() as never)

    const result = toolResult(history, 'save_local')
    expect(result.error).toContain('load_tools')
    expect(result.error).toContain('"data"')
  })

  it('reports unknown group names and keeps the conversation scoped', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'load_tools', { groups: ['tabs', 'bogus'] })],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'tabs please' },
    ]
    const conversationId = 'scoped-conv-1'
    await runAgentTurn(history as never, deps({ conversationId }) as never)

    const result = toolResult(history, 'load_tools')
    expect(result.loaded).toEqual(['tabs'])
    expect(result.unknownGroups).toEqual(['bogus'])

    // The load is conversation-scoped: a different conversation starts clean.
    const otherNames = advertiseTools({ mode: 'full' }).map((tool) => tool.function.name)
    expect(otherNames).not.toContain('tab_new')
  })
})
