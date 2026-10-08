/**
 * The bridge's routing for the tools that outrun a request: a generation turn,
 * a verification replay and a replay-and-repair must all START and be POLLED,
 * never awaited, or the adapter's response timeout discards the reply while the
 * run keeps going against the page.
 *
 * Everything the route delegates to is mocked; this pins the protocol shape
 * callers see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runToolStandalone = vi.fn()
const startGenerationRun = vi.fn()
const startVerificationRun = vi.fn()
const startRepairRun = vi.fn()
const readGenerationRun = vi.fn()
const resolveBridgeTarget = vi.fn()
vi.mock('../src/background/agent', () => ({
  TOOLS: [],
  runToolStandalone: (...args: unknown[]) => runToolStandalone(...args),
}))
vi.mock('../src/background/agent-unattended', () => ({ runUnattendedPrompt: vi.fn() }))
vi.mock('../src/background/workflow-generation-bridge', () => ({
  startGenerationRun: (...args: unknown[]) => startGenerationRun(...args),
  startVerificationRun: (...args: unknown[]) => startVerificationRun(...args),
  startRepairRun: (...args: unknown[]) => startRepairRun(...args),
  readGenerationRun: (...args: unknown[]) => readGenerationRun(...args),
}))
vi.mock('../src/background/window-policy', () => ({
  resolveBridgeTarget: (...args: unknown[]) => resolveBridgeTarget(...args),
}))
vi.mock('../src/background/driver', () => ({
  execOnActiveTab: vi.fn(),
  resolveAutomationTab: vi.fn(),
}))

import { processAgentRequest } from '../src/background/agent-api'

const settings = {
  localAgentEnabled: true,
  localAgentToken: '',
} as never

function call(args: Record<string, unknown>) {
  return processAgentRequest({ id: 'r1', type: 'tool', tool: 'generate_workflow', args }, settings)
}

function callVerify(args: Record<string, unknown>) {
  return processAgentRequest({ id: 'r1', type: 'tool', tool: 'verify_workflow', args }, settings)
}

beforeEach(() => {
  runToolStandalone.mockReset()
  startGenerationRun
    .mockReset()
    .mockReturnValue({ conversationId: 'external-gen:9', status: 'running' })
  startVerificationRun
    .mockReset()
    .mockReturnValue({ conversationId: 'external-verify:9', status: 'running' })
  startRepairRun
    .mockReset()
    .mockReturnValue({ conversationId: 'external-repair:9', status: 'running' })
  readGenerationRun.mockReset().mockResolvedValue({ status: 'settled' })
  resolveBridgeTarget.mockReset().mockResolvedValue({ scope: { windowId: 7 }, unbound: false })
})

describe('generate_workflow over the local-agent bridge', () => {
  it('starts a run scoped to the connection window and returns its handle', async () => {
    const out = await call({ prompt: '去小红书生成推广文章并保存成草稿' })

    expect(startGenerationRun).toHaveBeenCalledWith({
      prompt: '去小红书生成推广文章并保存成草稿',
      scopeWindowId: 7,
    })
    expect(runToolStandalone).not.toHaveBeenCalled()
    expect(out).toEqual({ ok: true, data: { conversationId: 'external-gen:9', status: 'running' } })
  })

  it('polls an existing run by conversationId', async () => {
    const out = await call({ conversationId: 'external-gen:9' })

    expect(readGenerationRun).toHaveBeenCalledWith('external-gen:9')
    expect(startGenerationRun).not.toHaveBeenCalled()
    expect(out).toEqual({ ok: true, data: { status: 'settled' } })
  })

  it('refuses a call with neither argument instead of starting an empty turn', async () => {
    const out = await call({})

    expect(out).toMatchObject({ ok: false })
    expect((out as { error: string }).error).toContain('prompt')
    expect(startGenerationRun).not.toHaveBeenCalled()
  })

  it('leaves every other tool to the standalone path', async () => {
    runToolStandalone.mockResolvedValue({ ok: true })

    const out = await processAgentRequest(
      { id: 'r2', type: 'tool', tool: 'screenshot', args: {} },
      settings,
    )

    expect(out).toEqual({ ok: true, data: { ok: true } })
    expect(startGenerationRun).not.toHaveBeenCalled()
  })
})

describe('verify_workflow over the local-agent bridge', () => {
  it('starts a replay of a saved workflow scoped to the connection window', async () => {
    const out = await callVerify({ workflowId: 'munulkib-z0h1mgc6' })

    expect(startVerificationRun).toHaveBeenCalledWith({
      workflowId: 'munulkib-z0h1mgc6',
      scopeWindowId: 7,
    })
    expect(runToolStandalone).not.toHaveBeenCalled()
    expect(out).toEqual({
      ok: true,
      data: { conversationId: 'external-verify:9', status: 'running' },
    })
  })

  it('passes a caller-supplied budget through, and ignores a nonsense one', async () => {
    await callVerify({ workflowId: 'wf-1', budgetMs: 20_000 })
    expect(startVerificationRun).toHaveBeenLastCalledWith({
      workflowId: 'wf-1',
      scopeWindowId: 7,
      budgetMs: 20_000,
    })

    await callVerify({ workflowId: 'wf-1', budgetMs: 'soon' })
    expect(startVerificationRun).toHaveBeenLastCalledWith({
      workflowId: 'wf-1',
      scopeWindowId: 7,
    })
  })

  it('forwards the tab cleanup opt-in to the run that owns it', async () => {
    // A harness that re-runs a graph is the one that has to clean up after it, so
    // the decision arrives with the call — and only a literal `true` opens it.
    await callVerify({ workflowId: 'wf-1', closeTabsAtEnd: true })
    expect(startVerificationRun).toHaveBeenLastCalledWith({
      workflowId: 'wf-1',
      scopeWindowId: 7,
      closeTabsAtEnd: true,
    })

    await callVerify({ workflowId: 'wf-1', closeTabsAtEnd: 'yes' })
    expect(startVerificationRun).toHaveBeenLastCalledWith({
      workflowId: 'wf-1',
      scopeWindowId: 7,
    })

    await call({ prompt: 'x', closeTabsAtEnd: true })
    expect(startGenerationRun).toHaveBeenLastCalledWith({
      prompt: 'x',
      scopeWindowId: 7,
      closeTabsAtEnd: true,
    })
  })

  it('forwards the commit-cutoff opt-in, and only the replay routes get it', async () => {
    // The generation turn owns a graph nobody has approved yet, so its pre-save
    // trial is never handed side effects; a replay the caller asked for by id is.
    await callVerify({ workflowId: 'wf-1', commitCutoffOnly: true })
    expect(startVerificationRun).toHaveBeenLastCalledWith({
      workflowId: 'wf-1',
      scopeWindowId: 7,
      commitCutoffOnly: true,
    })

    await callVerify({ workflowId: 'wf-1', commitCutoffOnly: 'yes' })
    expect(startVerificationRun).toHaveBeenLastCalledWith({
      workflowId: 'wf-1',
      scopeWindowId: 7,
    })

    await call({ prompt: 'x', commitCutoffOnly: true })
    expect(startGenerationRun).toHaveBeenLastCalledWith({ prompt: 'x', scopeWindowId: 7 })

    // The draft opt-in is read the same strict way: it writes into the user's
    // account, so a truthy string is not a request for it.
    await callVerify({ workflowId: 'wf-1', commitCutoffOnly: true, allowDraftCommit: true })
    expect(startVerificationRun).toHaveBeenLastCalledWith({
      workflowId: 'wf-1',
      scopeWindowId: 7,
      commitCutoffOnly: true,
      allowDraftCommit: true,
    })

    await callVerify({ workflowId: 'wf-1', allowDraftCommit: 'yes' })
    expect(startVerificationRun).toHaveBeenLastCalledWith({
      workflowId: 'wf-1',
      scopeWindowId: 7,
    })
  })

  it('forwards the declared inputs, and drops a map it cannot read', async () => {
    await callVerify({ workflowId: 'wf-1', inputs: { topic: '周末探店', count: 3 } })
    expect(startVerificationRun).toHaveBeenLastCalledWith({
      workflowId: 'wf-1',
      scopeWindowId: 7,
      inputs: { topic: '周末探店', count: 3 },
    })

    // These become the run's variable scope. An object value, a `__proto__` key
    // or a non-object map is dropped WHOLE rather than applied partially: a
    // replay that ran with half the inputs it asked for is worse evidence than
    // one that ran with none.
    for (const bad of [
      { topic: { a: 1 } },
      { topic: null },
      JSON.parse('{"__proto__":"x"}'),
      'topic=周末探店',
      [],
    ]) {
      await callVerify({ workflowId: 'wf-1', inputs: bad })
      expect(startVerificationRun).toHaveBeenLastCalledWith({
        workflowId: 'wf-1',
        scopeWindowId: 7,
      })
    }
  })

  it('polls a replay through the same run registry', async () => {
    const out = await callVerify({ conversationId: 'external-verify:9' })

    expect(readGenerationRun).toHaveBeenCalledWith('external-verify:9')
    expect(startVerificationRun).not.toHaveBeenCalled()
    expect(out).toEqual({ ok: true, data: { status: 'settled' } })
  })

  it('refuses a call with neither argument instead of replaying nothing', async () => {
    const out = await callVerify({})

    expect(out).toMatchObject({ ok: false })
    expect((out as { error: string }).error).toContain('workflowId')
    expect(startVerificationRun).not.toHaveBeenCalled()
  })

  it('is never handed to the standalone tool path', async () => {
    runToolStandalone.mockResolvedValue({ ok: true })

    await callVerify({ workflowId: 'wf-1' })

    expect(runToolStandalone).not.toHaveBeenCalled()
  })
})

describe('repair_workflow over the local-agent bridge', () => {
  // The repair loop needs a model, and the bridge reads no settings itself — so
  // the route resolves the provider the same way the panel's run button does.
  const repairSettings = {
    localAgentEnabled: true,
    localAgentToken: '',
    disabledTools: [],
    activeProviderId: 'p1',
    providers: [
      {
        id: 'p1',
        name: 'Main',
        apiKey: 'sk-test',
        baseUrl: 'https://llm.test/v1',
        model: 'some-model',
        headers: { 'x-a': 'b' },
        temperature: 0.2,
      },
    ],
  }

  function callRepair(args: Record<string, unknown>) {
    return processAgentRequest(
      { id: 'r4', type: 'tool', tool: 'repair_workflow', args },
      repairSettings as never,
    )
  }

  it('starts a replay-and-repair with the provider the settings resolve to', async () => {
    startRepairRun.mockReturnValue({ conversationId: 'external-repair:9', status: 'running' })

    const out = await callRepair({ workflowId: 'wf-1', budgetMs: 60_000 })

    expect(startRepairRun).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      scopeWindowId: 7,
      budgetMs: 60_000,
      model: {
        apiKey: 'sk-test',
        baseUrl: 'https://llm.test/v1',
        model: 'some-model',
        headers: { 'x-a': 'b' },
      },
    })
    expect(runToolStandalone).not.toHaveBeenCalled()
    expect(out).toEqual({
      ok: true,
      data: { conversationId: 'external-repair:9', status: 'running' },
    })
  })

  it('forwards the tab cleanup opt-in, because a repair opens tabs twice', async () => {
    // A repair is replay → candidate checks → replay, all in one run, so the one
    // flag the caller set has to reach the entry that owns the whole of it.
    const out = await callRepair({ workflowId: 'wf-1', closeTabsAtEnd: true })

    expect(out).toMatchObject({ ok: true })
    expect(startRepairRun).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-1', closeTabsAtEnd: true }),
    )
  })

  it('forwards the commit-cutoff opt-in through both of its replays', async () => {
    // A repair replays the graph before and after the loop; one caller decision
    // has to cover both, or the second replay silently changes the rules.
    const out = await callRepair({ workflowId: 'wf-1', commitCutoffOnly: true })

    expect(out).toMatchObject({ ok: true })
    expect(startRepairRun).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-1', commitCutoffOnly: true }),
    )
  })

  it('forwards the declared inputs through both of its replays', async () => {
    const out = await callRepair({ workflowId: 'wf-1', inputs: { topic: '周末探店' } })

    expect(out).toMatchObject({ ok: true })
    expect(startRepairRun).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-1', inputs: { topic: '周末探店' } }),
    )
  })

  it('polls a repair run through the same registry', async () => {
    const out = await callRepair({ conversationId: 'external-repair:9' })

    expect(readGenerationRun).toHaveBeenCalledWith('external-repair:9')
    expect(startRepairRun).not.toHaveBeenCalled()
    expect(out).toEqual({ ok: true, data: { status: 'settled' } })
  })

  it('refuses a call with neither argument', async () => {
    const out = await callRepair({})

    expect(out).toMatchObject({ ok: false })
    expect((out as { error: string }).error).toContain('workflowId')
    expect(startRepairRun).not.toHaveBeenCalled()
  })

  it('honours the settings tool switch, because repair writes revisions', async () => {
    const out = await processAgentRequest(
      {
        id: 'r5',
        type: 'tool',
        tool: 'repair_workflow',
        args: { workflowId: 'wf-1' },
      },
      { ...repairSettings, disabledTools: ['repair_workflow'] } as never,
    )

    expect(out).toMatchObject({ ok: false })
    expect((out as { error: string }).error).toContain('repair_workflow')
    expect(startRepairRun).not.toHaveBeenCalled()
  })

  it('still starts without a model when no provider is configured', async () => {
    startRepairRun.mockReturnValue({ conversationId: 'external-repair:10', status: 'running' })

    await processAgentRequest(
      {
        id: 'r6',
        type: 'tool',
        tool: 'repair_workflow',
        args: { workflowId: 'wf-1' },
      },
      {
        localAgentEnabled: true,
        localAgentToken: '',
        disabledTools: [],
        activeProviderId: '',
        providers: [],
      } as never,
    )

    expect(startRepairRun).toHaveBeenCalledWith({ workflowId: 'wf-1', scopeWindowId: 7 })
  })
})

describe('reload_extension over the local-agent bridge', () => {
  const reload = vi.fn()
  const devSettings = {
    localAgentEnabled: true,
    localAgentToken: '',
    localAgentAllowReload: true,
    disabledTools: [],
  } as never

  function callReload(args: Record<string, unknown>, withSettings: unknown = devSettings) {
    return processAgentRequest(
      { id: 'r3', type: 'tool', tool: 'reload_extension', args },
      withSettings as never,
    )
  }

  beforeEach(() => {
    vi.useFakeTimers()
    reload.mockReset()
    vi.stubGlobal('chrome', {
      runtime: { reload, getManifest: () => ({ version: '9.9.9' }) },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('answers first and reloads after, so the reply is not torn down', async () => {
    const out = await callReload({ confirm: 'reload' })

    expect(out).toMatchObject({ ok: true, data: { reloading: true, version: '9.9.9' } })
    expect(reload).not.toHaveBeenCalled()
    expect(runToolStandalone).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('refuses while the developer setting is off', async () => {
    const out = await callReload({ confirm: 'reload' }, settings)

    expect(out).toMatchObject({ ok: false })
    expect((out as { error: string }).error).toContain('reload_extension')
    vi.advanceTimersByTime(1000)
    expect(reload).not.toHaveBeenCalled()
  })

  it('refuses a call without the literal confirm', async () => {
    const out = await callReload({})

    expect(out).toMatchObject({ ok: false })
    expect((out as { error: string }).error).toContain('confirm')
    vi.advanceTimersByTime(1000)
    expect(reload).not.toHaveBeenCalled()
  })

  it('honours the settings tool switch, which is what lists it', async () => {
    const out = await callReload({ confirm: 'reload' }, {
      localAgentEnabled: true,
      localAgentToken: '',
      localAgentAllowReload: true,
      disabledTools: ['reload_extension'],
    } as never)

    expect(out).toMatchObject({ ok: false })
    vi.advanceTimersByTime(1000)
    expect(reload).not.toHaveBeenCalled()
  })
})
