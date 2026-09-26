import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentServerMessage } from '../src/lib/messages'
import {
  advertiseTools,
  isPageAction,
  modeAutoApproves,
  runAgentTurn,
  TOOL_GROUPS,
  USE_OPERATORS_TOOL,
} from '../src/background/agent'
import {
  ADVERTISABLE_OPERATOR_CATEGORIES,
  CORE_OPERATOR_TOOL_NAMES,
  OPERATOR_CATEGORY_TOOL_NAMES,
  operatorCategoryGroup,
} from '../src/lib/workflow/operator-categories'
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

  it('auto-loads the group on a direct call and tells the model to retry', async () => {
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
    expect(result.error).toContain('auto-loaded')
    expect(result.error).toContain('data')
    expect(result.error).toContain('again')
    // The next round must carry the freshly loaded group's schemas.
    expect(advertisedNames(1)).toContain('save_local')
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

describe('workflow operator tools are gated to workflow mode', () => {
  // ['compose_workflow', ...every wf_op_*] — the operators group.
  const operatorNames = TOOL_GROUPS.operators!
  const authorNames = TOOL_GROUPS.operators_author!
  const escapeNames = TOOL_GROUPS.operators_escape!
  const categoryGroups = ADVERTISABLE_OPERATOR_CATEGORIES.map(operatorCategoryGroup)

  it('drives the page with the operator tools, not the native action tools', () => {
    // The mode is OPERATOR-DIRECT: every step is a `wf_op_*` call, which both
    // operates the page and records the node. The native action tools are
    // withheld because they record nothing — a model reaching for the shorter,
    // more familiar `click` would finish the task and leave an empty draft,
    // which is exactly how the save card disappeared before.
    const wf = advertiseTools({ mode: 'workflow' }).map((tool) => tool.function.name)
    for (const name of ['click', 'fill', 'open_url', 'press_key', 'scroll', 'select_option']) {
      expect(wf).not.toContain(name)
    }
    // `run_javascript` is never offered in this mode, even after loading the
    // escape group: the recording equivalent is `wf_op_javascript-code`.
    expect(wf).not.toContain('run_javascript')
    // Every category is advertised from round one (the undeclared default);
    // only an explicit use_operators declaration narrows the surface.
    const expected = ADVERTISABLE_OPERATOR_CATEGORIES.flatMap(
      (category) => OPERATOR_CATEGORY_TOOL_NAMES[category],
    )
    const advertisedOperators = wf.filter((name) => name.startsWith('wf_op_'))
    expect(advertisedOperators.sort()).toEqual([...expected].sort())
    expect(wf).not.toContain('compose_workflow')
  })

  it('keeps the read tools: `ref` targeting depends on snapshot_page', () => {
    const wf = advertiseTools({ mode: 'workflow' }).map((tool) => tool.function.name)
    for (const name of ['read_current_page', 'snapshot_page', 'recognize_image', 'list_tabs']) {
      expect(wf).toContain(name)
    }
  })

  it('advertises use_operators, or the categories are undiscoverable', () => {
    const tool = advertiseTools({ mode: 'workflow' }).find(
      (t) => t.function.name === USE_OPERATORS_TOOL,
    )
    expect(tool).toBeDefined()
    const enum_ = (
      tool!.function.parameters as {
        properties?: { categories?: { items?: { enum?: string[] } } }
      }
    ).properties?.categories?.items?.enum
    // Only categories that actually have members: `onlineServices` and
    // `package` are cloud-only in this build, so listing them would teach the
    // model to ask for an empty set.
    expect(enum_).toEqual([...ADVERTISABLE_OPERATOR_CATEGORIES])
  })

  it('widens to a declared category without dropping the core', () => {
    const names = advertiseTools({
      mode: 'workflow',
      activeOperatorCategories: new Set(['data']),
    }).map((t) => t.function.name)
    for (const name of OPERATOR_CATEGORY_TOOL_NAMES.data) expect(names).toContain(name)
    for (const name of CORE_OPERATOR_TOOL_NAMES) expect(names).toContain(name)
    expect(names).not.toContain('wf_op_loop-data')
  })

  it('REPLACES the active categories rather than accumulating them', () => {
    // Otherwise a long conversation ends up paying for every category it ever
    // touched, which is the whole cost problem the dispatch exists to solve.
    const names = advertiseTools({
      mode: 'workflow',
      activeOperatorCategories: new Set(['data']),
    }).map((t) => t.function.name)
    for (const name of OPERATOR_CATEGORY_TOOL_NAMES.interaction) {
      // `forms` and friends are core, so those legitimately stay.
      if (CORE_OPERATOR_TOOL_NAMES.includes(name)) continue
      expect(names).not.toContain(name)
    }
  })

  it('advertises no duplicate tool names', () => {
    // The core four are also `interaction` members, so a naive union would
    // repeat them — and a provider rejects a tool list with duplicate names.
    const names = advertiseTools({
      mode: 'workflow',
      activeOperatorCategories: new Set(ADVERTISABLE_OPERATOR_CATEGORIES),
    }).map((t) => t.function.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('advertises load_tools with the operator groups and the ordinary non-page groups', () => {
    const wf = advertiseTools({ mode: 'workflow' })
    const loadTools = wf.find((tool) => tool.function.name === 'load_tools')
    expect(loadTools).toBeDefined()
    const enum_ =
      (
        loadTools!.function.parameters as {
          properties?: { groups?: { items?: { enum?: string[] } } }
        }
      ).properties?.groups?.items?.enum ?? []
    // The operator escape hatches, plus the non-page groups so workflow
    // generation really does keep every capability of the other modes.
    expect(enum_).toContain('operators_author')
    expect(enum_).toContain('operators_escape')
    expect(enum_).toContain('data')
    // `tabs` is deliberately absent: the listing is advertised outright and the
    // tab ACTIONS are operators, so loading it would hand back native tools
    // that record nothing.
    expect(enum_).not.toContain('tabs')
  })

  it('only advertises the JavaScript escape operator after it was loaded (never run_javascript)', () => {
    const names = (groups: string[]) =>
      advertiseTools({ mode: 'workflow', loadedGroups: new Set(groups) }).map(
        (tool) => tool.function.name,
      )
    const escapeName = escapeNames[0]!

    expect(names(['operators_author'])).not.toContain(escapeName)
    expect(names(['operators_escape'])).toContain(escapeName)
    // The legacy all-in-one group really does carry it, so loading that one
    // must not produce an advertised set that contradicts its own tool list.
    expect(names(['operators'])).toContain(escapeName)
    // Whichever group is loaded, the native `run_javascript` never appears —
    // only the recording operator carries script steps here.
    for (const groups of [['operators_escape'], ['operators'], ['operators_author']]) {
      expect(names(groups)).not.toContain('run_javascript')
    }
  })

  it('never advertises wf_op_* or compose_workflow outside workflow mode', () => {
    for (const mode of ['readonly', 'semi', 'full'] as const) {
      const names = advertiseTools({ mode }).map((tool) => tool.function.name)
      for (const name of operatorNames) expect(names).not.toContain(name)
    }
  })

  it('drops use_operators and every operator group outside workflow mode', () => {
    for (const mode of ['readonly', 'semi', 'full'] as const) {
      const loadTools = advertiseTools({ mode }).find(
        (tool) => tool.function.name === 'load_tools',
      )!
      const params = loadTools.function.parameters as {
        properties?: { groups?: { items?: { enum?: string[] } } }
      }
      const enum_ = params.properties?.groups?.items?.enum ?? []
      expect(enum_).not.toContain('operators')
      expect(enum_).not.toContain('operators_author')
      expect(enum_).not.toContain('operators_escape')
      for (const group of categoryGroups) expect(enum_).not.toContain(group)
      expect(enum_).toContain('tabs')

      const names = advertiseTools({ mode }).map((tool) => tool.function.name)
      expect(names).not.toContain(USE_OPERATORS_TOOL)
    }
  })

  it('rejects the operators group via load_tools outside workflow mode', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'load_tools', { groups: ['tabs', 'operators'] })],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'tabs + workflow operators' },
    ]
    await runAgentTurn(history as never, deps({ getMode: async () => 'full' as const }) as never)

    const result = toolResult(history, 'load_tools')
    expect(result.loaded).toEqual(['tabs']) // operators silently dropped
    // The widened next round still never exposes operator/composition tools.
    expect(advertisedNames(1).some((name) => operatorNames.includes(name))).toBe(false)
  })

  it('keeps the operators group loadable in workflow mode', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'load_tools', { groups: ['operators'] })],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'build a workflow' },
    ]
    await runAgentTurn(
      history as never,
      deps({ getMode: async () => 'workflow' as const }) as never,
    )

    const result = toolResult(history, 'load_tools')
    expect(result.loaded).toContain('operators')
    // Loading the full operator group widens the next round to everything.
    const next = advertisedNames(1)
    for (const name of authorNames) expect(next).toContain(name)
  })

  it('widens to the authoring tail when operators_author is loaded', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'load_tools', { groups: ['operators_author'] })],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'build a workflow with a loop' },
    ]
    await runAgentTurn(
      history as never,
      deps({ getMode: async () => 'workflow' as const }) as never,
    )

    expect(toolResult(history, 'load_tools').loaded).toEqual(['operators_author'])
    const next = advertisedNames(1)
    for (const name of authorNames) expect(next).toContain(name)
    // Widening must not displace the core the task is driven with.
    for (const name of CORE_OPERATOR_TOOL_NAMES) expect(next).toContain(name)
  })

  it('activates just the CATEGORY when an undeclared operator is called', async () => {
    // With the every-category round-1 default, a stray operator call only
    // happens after the model NARROWED the surface via use_operators — so the
    // scenario is: declare `data`, then reach for `wf_op_loop-data` (category
    // `conditions`). Activating just that category — and merging it into what
    // is already active, mid-task — is the awakening contract.
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c0', USE_OPERATORS_TOOL, { categories: ['data'] })],
      } as never)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', 'wf_op_loop-data', { selector: '#row' })],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'loop over the rows' },
    ]
    await runAgentTurn(
      history as never,
      deps({ getMode: async () => 'workflow' as const }) as never,
    )

    // The narrowing took effect first: after use_operators, `conditions` is out.
    const narrowed = advertisedNames(1)
    expect(narrowed).not.toContain('wf_op_loop-data')

    expect(JSON.stringify(history)).toContain('operator category has been activated')
    const next = advertisedNames(2)
    expect(next).toContain('wf_op_loop-data')
    for (const name of OPERATOR_CATEGORY_TOOL_NAMES.conditions) expect(next).toContain(name)
    // The declared category survived the activation: it is a merge, not a
    // replacement.
    for (const name of OPERATOR_CATEGORY_TOOL_NAMES.data) expect(next).toContain(name)
    // Categories that were neither declared nor awakened stay out.
    expect(next).not.toContain('wf_op_webhook')
  })

  it('activates a category declared through use_operators', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', USE_OPERATORS_TOOL, { categories: ['data'] })],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'clean up the scraped data' },
    ]
    await runAgentTurn(
      history as never,
      deps({ getMode: async () => 'workflow' as const }) as never,
    )

    const next = advertisedNames(1)
    for (const name of OPERATOR_CATEGORY_TOOL_NAMES.data) expect(next).toContain(name)
    expect(next).not.toContain('wf_op_loop-data')
  })

  it('reports what changed and can drop categories again', async () => {
    streamMock
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c1', USE_OPERATORS_TOOL, { categories: ['data', 'conditions'] })],
      } as never)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [toolCall('c2', USE_OPERATORS_TOOL, { categories: [] })],
      } as never)
      .mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)

    const history: { role: string; name?: string; content?: string }[] = [
      { role: 'user', content: 'scrape then tidy' },
    ]
    await runAgentTurn(
      history as never,
      deps({ getMode: async () => 'workflow' as const }) as never,
    )

    const results = history.filter((entry) => entry.name === USE_OPERATORS_TOOL)
    expect(results).toHaveLength(2)
    // The second call reports what it dropped, so the model can see the effect
    // without spending another round discovering it.
    expect(results[1]!.content).toContain('"removed"')
    const final = advertisedNames(2)
    for (const name of CORE_OPERATOR_TOOL_NAMES) expect(final).toContain(name)
    expect(final.filter((name) => name.startsWith('wf_op_')).sort()).toEqual(
      [...CORE_OPERATOR_TOOL_NAMES].sort(),
    )
  })
})

describe('one-click approval gate (modeAutoApproves)', () => {
  // A popup-free workflow-generation run is the contract: the model keeps
  // calling raw page tools (open_url/click) while drafting, and any one of
  // them stuck behind an approval card would stall the turn.
  it('never asks for approval on page actions or reads in workflow mode', () => {
    expect(modeAutoApproves('workflow', 'open_url')).toBe(true)
    expect(modeAutoApproves('workflow', 'click')).toBe(true)
    expect(modeAutoApproves('workflow', 'read_current_page')).toBe(true)
  })

  it('full auto is also approval-free for the same tools', () => {
    expect(modeAutoApproves('full', 'open_url')).toBe(true)
    expect(modeAutoApproves('full', 'read_current_page')).toBe(true)
  })

  it('semi mode still asks on page actions', () => {
    expect(modeAutoApproves('semi', 'open_url')).toBe(false)
    expect(modeAutoApproves('semi', 'click')).toBe(false)
  })

  it('treats workflow operators as page actions in every other mode', () => {
    // An operator really clicks / types / navigates. It is only advertised in
    // workflow mode, but the advertised set is fixed by the mode the turn
    // STARTED with — so a mid-turn switch to read-only must still stop it.
    for (const mode of ['readonly', 'semi'] as const) {
      expect(modeAutoApproves(mode, 'wf_op_event-click')).toBe(false)
      expect(modeAutoApproves(mode, 'wf_op_new-tab')).toBe(false)
    }
    // Workflow mode itself stays approval-free.
    expect(modeAutoApproves('workflow', 'wf_op_event-click')).toBe(true)
  })

  it('classifies operators and raw page tools alike', () => {
    expect(isPageAction('click')).toBe(true)
    expect(isPageAction('wf_op_forms')).toBe(true)
    expect(isPageAction('read_current_page')).toBe(false)
    expect(isPageAction('load_tools')).toBe(false)
    expect(isPageAction('get_secret')).toBe(false)
  })

  it('always auto-approves pure bookkeeping tools, whatever the mode', () => {
    for (const mode of ['semi', 'full', 'workflow'] as const) {
      expect(modeAutoApproves(mode, 'load_tools')).toBe(true)
      expect(modeAutoApproves(mode, 'get_secret')).toBe(true)
    }
  })
})
