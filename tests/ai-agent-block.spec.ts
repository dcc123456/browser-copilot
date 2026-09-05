/**
 * Tests for the Browser-Copilot extension block `ai-agent` ("AI agent"):
 *  - catalog/palette wiring: it shows in the palette, resolves via the lookups,
 *    is not treated as a cloud block, and carries the expected default data;
 *  - localization: a Chinese display name resolves;
 *  - migration: defaults are filled in for a sparse node payload;
 *  - executor: prompt building/interpolation, mode selection (read-only vs full
 *    auto), element reading, output variables, and the no-provider error path.
 *
 * The agent loop itself (`runUnattendedPrompt`) and settings are mocked so no
 * model/network/chrome access happens; element reading uses a chrome stub.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

// --- Mock the unattended runner and settings before importing the executor. ---
const runUnattended = vi.fn()
vi.mock('../src/background/agent-unattended', () => ({
  runUnattendedPrompt: (...args: unknown[]) => runUnattended(...args),
}))

const getSettingsMock = vi.fn()
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return { ...actual, getSettings: (...args: unknown[]) => getSettingsMock(...args) }
})

import { PALETTE_BLOCKS, BLOCK_BY_ID, CATALOG_BY_ID } from '../src/lib/workflow/blocks/palette'
import { CUSTOM_BLOCKS, CUSTOM_BLOCK_IDS, isCustomBlock } from '../src/lib/workflow/blocks/custom'
import { isCloudBlock } from '../src/lib/workflow/blocks/cloud-blocks'
import { blockDisplayName } from '../src/workflow-editor/block-i18n'
import { migrateNodeData } from '../src/lib/workflow/migrate'
import { buildAgentPrompt } from '../src/background/workflow-engine/ai-agent-executor'
import { EXECUTORS, type WorkflowExecCtx } from '../src/background/workflow-engine/executors'

function configuredSettings() {
  getSettingsMock.mockResolvedValue({
    providers: [{ id: 'p1', apiKey: 'k', baseUrl: 'https://x', model: 'm' }],
    activeProviderId: 'p1',
  })
}

function makeCtx(chromeStub?: unknown) {
  const emit = vi.fn((_kind: string, _text: string) => {})
  const ctx: WorkflowExecCtx = {
    variables: {},
    refData: undefined,
    signal: new AbortController().signal,
    emit: emit as WorkflowExecCtx['emit'],
  }
  if (chromeStub) (globalThis as { chrome?: unknown }).chrome = chromeStub
  return { ctx, emit }
}

describe('ai-agent block catalog wiring', () => {
  it('is present in the palette and both lookups', () => {
    expect(PALETTE_BLOCKS.some((b) => b.id === 'ai-agent')).toBe(true)
    expect(BLOCK_BY_ID.get('ai-agent')?.name).toBe('AI agent')
    expect(CATALOG_BY_ID.get('ai-agent')?.id).toBe('ai-agent')
  })

  it('is a local block, not a cloud block', () => {
    expect(isCustomBlock('ai-agent')).toBe(true)
    expect(isCloudBlock('ai-agent')).toBe(false)
    expect(CUSTOM_BLOCK_IDS.has('ai-agent')).toBe(true)
  })

  it('has the expected default data and single in/out ports', () => {
    const b = BLOCK_BY_ID.get('ai-agent')!
    expect(b.inputs).toBe(1)
    expect(b.outputs).toBe(1)
    expect(b.editComponent).toBe('EditAiAgent')
    expect(b.tag).toBe('AI')
    expect(b.data['prompt']).toBe('')
    expect(b.data['actOnPage']).toBe(false)
    expect(b.data['useSnapshot']).toBe(true)
    expect(b.data['maxToolRounds']).toBe(20)
    expect(b.data['variableName']).toBe('lastAIAgent')
  })

  it('does not collide with any Automa catalog id', () => {
    const automaIds = new Set(PALETTE_BLOCKS.filter((b) => !CUSTOM_BLOCK_IDS.has(b.id)).map((b) => b.id))
    for (const custom of CUSTOM_BLOCKS) expect(automaIds.has(custom.id)).toBe(false)
  })

  it('localizes to a Chinese name', () => {
    expect(blockDisplayName('ai-agent', 'AI agent', 'zh')).toBe('AI 智能体')
    expect(blockDisplayName('ai-agent', 'AI agent', 'en')).toBe('AI agent')
  })

  it('migration fills defaults for a sparse ai-agent node', () => {
    const { blockId, data } = migrateNodeData('ai-agent', { prompt: 'do x' })
    expect(blockId).toBe('ai-agent')
    expect(data['prompt']).toBe('do x')
    expect(data['actOnPage']).toBe(false)
    expect(data['findBy']).toBe('cssSelector')
    expect(data['variableName']).toBe('lastAIAgent')
  })
})

describe('buildAgentPrompt', () => {
  it('includes element text and the user instruction', () => {
    const p = buildAgentPrompt({
      userPrompt: 'Summarize it',
      selector: '.price',
      elementText: '$19.99',
      elementFound: true,
      useSnapshot: true,
      actOnPage: false,
    })
    expect(p).toContain('$19.99')
    expect(p).toContain('.price')
    expect(p).toContain('Summarize it')
    expect(p).toContain('snapshot_page')
    expect(p).toMatch(/READ-ONLY/)
  })

  it('states full-auto when acting is allowed', () => {
    const p = buildAgentPrompt({
      userPrompt: 'Buy it',
      selector: '',
      elementText: '',
      elementFound: false,
      useSnapshot: false,
      actOnPage: true,
    })
    expect(p).toMatch(/MAY act/)
    expect(p).not.toContain('snapshot_page')
  })

  it('reports a missing element', () => {
    const p = buildAgentPrompt({
      userPrompt: 'x',
      selector: '.nope',
      elementText: '',
      elementFound: false,
      useSnapshot: false,
      actOnPage: false,
    })
    expect(p).toContain('element not found')
  })
})

describe('ai-agent executor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete (globalThis as { chrome?: unknown }).chrome
  })

  it('emits an error and does not call the agent when no provider is configured', async () => {
    getSettingsMock.mockResolvedValue({ providers: [], activeProviderId: '' })
    const { ctx, emit } = makeCtx()
    await EXECUTORS['ai-agent']!({ prompt: 'hi' }, ctx)
    expect(runUnattended).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('error', expect.stringContaining('provider'))
  })

  it('emits an error when both prompt and selector are empty', async () => {
    configuredSettings()
    const { ctx, emit } = makeCtx()
    await EXECUTORS['ai-agent']!({}, ctx)
    expect(runUnattended).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('error', expect.stringContaining('提示词'))
  })

  it('runs read-only by default and stores the answer in the output variable', async () => {
    configuredSettings()
    runUnattended.mockResolvedValue({ ok: true, answer: 'all done' })
    const tab = { id: 7, url: 'https://example.com/', title: 'x', active: true }
    const { ctx, emit } = makeCtx({
      tabs: {
        get: vi.fn(async () => tab),
        query: vi.fn(async () => [tab]),
      },
      scripting: {
        executeScript: vi.fn(async () => [{ result: 'ELEMENT TEXT' }]),
      },
    })
    ctx.variables['name'] = 'Bob'

    await EXECUTORS['ai-agent']!(
      { prompt: 'Analyze {{name}}', selector: '.box', variableName: 'myResult' },
      ctx,
    )

    expect(runUnattended).toHaveBeenCalledTimes(1)
    const [prompt, conversationId, mode, options] = runUnattended.mock.calls[0] as [
      string, string, string, { maxToolRounds: number },
    ]
    expect(mode).toBe('readonly')
    expect(conversationId).toContain('workflow-ai-agent')
    expect(options.maxToolRounds).toBe(20)
    expect(prompt).toContain('ELEMENT TEXT')
    expect(prompt).toContain('Analyze Bob')
    expect(ctx.variables['myResult']).toBe('all done')
    expect(ctx.variables['lastAIAgent']).toBe('all done')
    expect(emit).toHaveBeenCalledWith('result', expect.stringContaining('all done'))
  })

  it('runs in full mode and passes the per-node round budget when actOnPage is set', async () => {
    configuredSettings()
    runUnattended.mockResolvedValue({ ok: true, answer: 'clicked' })
    const { ctx } = makeCtx()
    ctx.variables['name'] = 'Bob'

    await EXECUTORS['ai-agent']!(
      { prompt: 'Do {{name}}', actOnPage: true, maxToolRounds: 8, useSnapshot: false },
      ctx,
    )

    const [, , mode, options] = runUnattended.mock.calls[0] as [string, string, string, { maxToolRounds: number }]
    expect(mode).toBe('full')
    expect(options.maxToolRounds).toBe(8)
    expect(ctx.variables['lastAIAgent']).toBe('clicked')
  })

  it('pins the nested unattended turn to the workflow window scope', async () => {
    configuredSettings()
    runUnattended.mockResolvedValue({ ok: true, answer: 'scoped' })
    const { ctx } = makeCtx()
    // The workflow is running scoped to window 7 (panel/editor host window).
    ctx.scope = { windowId: 7 }

    await EXECUTORS['ai-agent']!({ prompt: 'Do it', useSnapshot: false }, ctx)

    expect(runUnattended).toHaveBeenCalledTimes(1)
    const [, , , options] = runUnattended.mock.calls[0] as unknown as [
      string, string, string, { scopeWindowId?: number },
    ]
    // Without this passthrough a second plugin window would capture the turn.
    expect(options.scopeWindowId).toBe(7)
  })

  it('surfaces agent failure as an error emit without throwing', async () => {
    configuredSettings()
    runUnattended.mockResolvedValue({ ok: false, answer: '', error: 'boom' })
    const { ctx, emit } = makeCtx()
    await expect(EXECUTORS['ai-agent']!({ prompt: 'go' }, ctx)).resolves.toBeNull()
    expect(emit).toHaveBeenCalledWith('error', expect.stringContaining('boom'))
    // Failure pre-sets the variable to '' so downstream {{lastAIAgent}} references
    // resolve to an empty value instead of raw unresolved tokens.
    expect(ctx.variables['lastAIAgent']).toBe('')
  })

  it('treats a cancelled run quietly', async () => {
    configuredSettings()
    runUnattended.mockResolvedValue({ ok: false, answer: '', cancelled: true, error: 'Cancelled' })
    const { ctx, emit } = makeCtx()
    await EXECUTORS['ai-agent']!({ prompt: 'go' }, ctx)
    expect(emit).toHaveBeenCalledWith('info', expect.stringContaining('取消'))
    expect(emit).not.toHaveBeenCalledWith('error', expect.anything())
  })
})
