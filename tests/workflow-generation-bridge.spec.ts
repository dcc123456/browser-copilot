/**
 * Tests for the unattended generation entry (`mode:'workflow'` without a side
 * panel): the turn must run in workflow mode on the caller's window, the draft
 * it recorded must be closed with a real save plus the pre-save trial replay,
 * and the saved graph's own evidence must come back to the caller. The sibling
 * verification entry — replaying a graph that is ALREADY saved — is covered
 * below: same trial runner, same verdict mapping, no generation turn. And the
 * third entry, which replays a saved graph and hands a FAILING replay to the
 * autonomous repair loop before measuring it again.
 *
 * The agent turn, the compose call, the stored graph, the trial runner and the
 * repair orchestrator are all mocked — what is under test here is the
 * sequencing, the evidence mapping, and the start/poll protocol the bridge uses
 * because a turn outlasts one request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workflow } from '../src/lib/workflow/types'

const runUnattendedPrompt = vi.fn()
const composeWorkflowFromDraft = vi.fn()
const createTrialRunner = vi.fn()
const hydrateDraft = vi.fn()
const getWorkflow = vi.fn()
const saveWorkflow = vi.fn()
vi.mock('../src/background/agent-unattended', () => ({
  runUnattendedPrompt: (...args: unknown[]) => runUnattendedPrompt(...args),
}))
vi.mock('../src/background/operator-tool-handler', () => ({
  composeWorkflowFromDraft: (...args: unknown[]) => composeWorkflowFromDraft(...args),
  hydrateDraft: (...args: unknown[]) => hydrateDraft(...args),
  // The draft's node count is the run's progress signal; a draft of N nodes is
  // stood in for N here so the mock stays a fixture, not a second implementation.
  actionNodesOf: (draft: { nodes: unknown[] }) => draft.nodes,
}))
vi.mock('../src/background/workflow-engine/repair/generation-trial', async (importOriginal) => {
  // `withTrialRecord` stays the real one: what the verification persists is part
  // of what is under test.
  const actual =
    await importOriginal<
      typeof import('../src/background/workflow-engine/repair/generation-trial')
    >()
  return { ...actual, createTrialRunner: (...args: unknown[]) => createTrialRunner(...args) }
})
vi.mock('../src/background/workflow-engine/run-workflow', () => ({
  executeWorkflow: vi.fn(),
}))
const startBackgroundAutoRepair = vi.fn()
const autoRepairEvents = vi.fn()
vi.mock('../src/background/workflow-engine/auto-repair/background-adapter', () => ({
  startBackgroundAutoRepair: (...args: unknown[]) => startBackgroundAutoRepair(...args),
  autoRepairEvents: (...args: unknown[]) => autoRepairEvents(...args),
  cancelAutoRepair: vi.fn(),
}))
const failureSnapshotForRun = vi.fn()
vi.mock('../src/background/workflow-engine/auto-repair/failure-snapshot', () => ({
  failureSnapshotForRun: (...args: unknown[]) => failureSnapshotForRun(...args),
  rememberFailedRun: vi.fn(),
}))
const verifyWorkflowGoal = vi.fn()
vi.mock('../src/background/workflow-engine/goal-verification', () => ({
  DEFAULT_GOAL_SETTLE_MS: 6000,
  verifyWorkflowGoal: (...args: unknown[]) => verifyWorkflowGoal(...args),
}))
vi.mock('../src/lib/workflow/storage', () => ({
  getWorkflow: (...args: unknown[]) => getWorkflow(...args),
  saveWorkflow: (...args: unknown[]) => saveWorkflow(...args),
}))

import {
  generateWorkflowUnattended,
  readGenerationRun,
  repairSavedWorkflowUnattended,
  startGenerationRun,
  startRepairRun,
  startVerificationRun,
  VERIFY_BUDGET_MS,
  verifySavedWorkflowUnattended,
} from '../src/background/workflow-generation-bridge'

const trialRunner = vi.fn()

function savedWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    name: '小红书图文推广',
    trigger: { type: 'manual', enabled: true },
    settings: {
      saveLog: true,
      debugMode: false,
      notification: false,
      reuseLastState: false,
      reliabilityMode: 'generated-strict',
      provenance: 'chat-generate',
      generationOriginUrl: 'https://creator.xiaohongshu.com/new/home',
      saveWarnings: ['[NODE_NO_WAIT] step 2 has no readiness gate'],
      trialRun: { outcome: 'passed', steps: 4 } as never,
    },
    drawflow: {
      nodes: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }] as never,
      edges: [] as never,
    },
    revision: 2,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function draft(nodeCount: number) {
  return { nodes: Array.from({ length: nodeCount }, (_, i) => ({ id: `n${i}` })) }
}

type FakeTab = { id: number; windowId: number; url?: string; pinned?: boolean }

/**
 * The tab set an unattended run sees: `open()` stands for the replay navigating,
 * `live()` says what is still on screen, `removed()` what the janitor closed.
 */
function makeTabs(initial: FakeTab[]) {
  const tabs = [...initial]
  const removed: number[] = []
  return {
    api: {
      query: vi.fn(async (query: { windowId?: number } = {}) =>
        tabs.filter((tab) => query.windowId === undefined || tab.windowId === query.windowId),
      ),
      remove: vi.fn(async (id: number) => {
        const at = tabs.findIndex((tab) => tab.id === id)
        if (at < 0) throw new Error(`no tab ${id}`)
        tabs.splice(at, 1)
        removed.push(id)
      }),
    },
    open: (tab: FakeTab) => tabs.push(tab),
    live: () => tabs.map((tab) => tab.id),
    removed: () => removed,
  }
}

/** Let the background generation promise chain settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

beforeEach(() => {
  runUnattendedPrompt.mockReset()
  composeWorkflowFromDraft.mockReset()
  createTrialRunner.mockReset().mockReturnValue(trialRunner)
  hydrateDraft.mockReset().mockResolvedValue(draft(0))
  getWorkflow.mockReset()
  saveWorkflow.mockReset().mockResolvedValue(undefined)
  trialRunner.mockReset()
  startBackgroundAutoRepair.mockReset()
  autoRepairEvents.mockReset().mockReturnValue([])
  failureSnapshotForRun.mockReset().mockReturnValue({ nodeId: 'n2' } as never)
  verifyWorkflowGoal.mockReset()
  // The tab janitor stubs `chrome`; a test that does not want it must not inherit
  // the previous one's browser.
  vi.unstubAllGlobals()
})

describe('generateWorkflowUnattended', () => {
  it('runs the turn in workflow mode and closes the draft with a save and a trial', async () => {
    runUnattendedPrompt.mockResolvedValue({ ok: true, answer: 'recorded 3 steps' })
    composeWorkflowFromDraft.mockResolvedValue({ workflow: savedWorkflow(), saved: true })

    const out = await generateWorkflowUnattended(
      { prompt: '去小红书生成推广文章并保存成草稿', scopeWindowId: 42 },
      'external-gen:1',
    )

    const [prompt, conversationId, mode, options] = runUnattendedPrompt.mock.calls[0] as [
      string,
      string,
      string,
      { scopeWindowId?: number },
    ]
    expect(prompt).toBe('去小红书生成推广文章并保存成草稿')
    expect(mode).toBe('workflow')
    expect(conversationId).toBe('external-gen:1')
    expect(options.scopeWindowId).toBe(42)

    const [composeConversationId, composeOptions] = composeWorkflowFromDraft.mock.lastCall as [
      string,
      { save: boolean; trial: unknown },
    ]
    expect(composeConversationId).toBe('external-gen:1')
    expect(composeOptions.save).toBe(true)
    const [trialArg] = createTrialRunner.mock.lastCall as [{ scopeWindowId?: number }]
    // The trial the save runs is scoped to the same window the turn acted on.
    expect(trialArg).toMatchObject({ scopeWindowId: 42 })
    expect(composeOptions.trial).toBe(trialRunner)

    expect(out.ok).toBe(true)
    expect(out.conversationId).toBe('external-gen:1')
    expect(out.workflow).toMatchObject({
      id: 'wf-1',
      saved: true,
      revision: 2,
      nodeCount: 3,
      reliabilityMode: 'generated-strict',
      generationOriginUrl: 'https://creator.xiaohongshu.com/new/home',
      saveWarnings: ['[NODE_NO_WAIT] step 2 has no readiness gate'],
    })
  })

  it('re-asks the missing terminal step once, in the same conversation', async () => {
    runUnattendedPrompt.mockResolvedValue({ ok: true, answer: '已保存草稿' })
    composeWorkflowFromDraft.mockResolvedValue({ workflow: savedWorkflow(), saved: true })
    // Round 39's shape: a draft-goal conversation whose last recorded step is a
    // click on the body editor, so nothing in the graph writes a draft.
    // Round 40's shape: an unattended bridge turn whose last recorded step is a
    // click on the body editor, so nothing in the graph writes a draft. The draft
    // carries NO goal text of its own — only the caller's prompt says what was asked.
    hydrateDraft.mockResolvedValue({
      nodes: [
        { id: 'n0', data: { blockId: 'new-tab' } },
        { id: 'n1', data: { blockId: 'event-click', description: '点击正文编辑区' } },
      ],
    })

    const out = await generateWorkflowUnattended(
      { prompt: '去小红书生成推广文章并保存成草稿', scopeWindowId: 42 },
      'external-gen:9',
    )

    const calls = runUnattendedPrompt.mock.calls as [string, string, string][]
    // Once, not repeatedly: a second re-ask of a model that just ignored the first
    // is a retry, and it costs a full turn.
    expect(calls).toHaveLength(2)
    const second = calls[1] as [string, string, string]
    expect(second[1]).toBe('external-gen:9')
    expect(second[2]).toBe('workflow')
    expect(second[0]).toContain('补做回合')
    expect(second[0]).toContain('绝不点击「发布」')
    expect(out.terminalStepContinuation).toMatchObject({
      stepsBefore: 2,
      stepsAfter: 2,
      ok: true,
    })
  })

  it('does not re-ask when the recorded draft already ends on its draft save', async () => {
    runUnattendedPrompt.mockResolvedValue({ ok: true, answer: 'done' })
    composeWorkflowFromDraft.mockResolvedValue({ workflow: savedWorkflow(), saved: true })
    hydrateDraft.mockResolvedValue({
      nodes: [
        { id: 'n0', data: { blockId: 'new-tab' } },
        {
          id: 'n1',
          data: {
            blockId: 'event-click',
            description: '点击「暂存离开」，把笔记保存为草稿，不执行正式发布',
          },
        },
      ],
    })

    const out = await generateWorkflowUnattended(
      { prompt: '去小红书生成推广文章并保存成草稿' },
      'external-gen:10',
    )

    expect(runUnattendedPrompt).toHaveBeenCalledTimes(1)
    expect(out.terminalStepContinuation).toBeUndefined()
  })

  it('reports a cancelled turn without touching the draft', async () => {
    runUnattendedPrompt.mockResolvedValue({ ok: false, answer: '', cancelled: true })

    const out = await generateWorkflowUnattended({ prompt: 'x' }, 'external-gen:2')

    expect(out).toMatchObject({ ok: false, conversationId: 'external-gen:2', error: 'Cancelled' })
    expect(composeWorkflowFromDraft).not.toHaveBeenCalled()
  })

  it('carries compose failures back with their issues', async () => {
    runUnattendedPrompt.mockResolvedValue({ ok: true, answer: 'done' })
    composeWorkflowFromDraft.mockResolvedValue({
      error: 'The graph is missing a producer for {{token}}.',
      issues: ['missing producer: {{token}}'],
    })

    const out = await generateWorkflowUnattended({ prompt: 'x' }, 'external-gen:3')

    expect(out.ok).toBe(false)
    expect(out.error).toContain('missing a producer')
    expect(out.issues).toEqual(['missing producer: {{token}}'])
  })

  it('still saves a graph when the turn itself failed', async () => {
    runUnattendedPrompt.mockResolvedValue({ ok: false, answer: 'stopped', error: 'LLM timeout' })
    composeWorkflowFromDraft.mockResolvedValue({ workflow: savedWorkflow(), saved: true })

    const out = await generateWorkflowUnattended({ prompt: 'x' }, 'external-gen:4')

    expect(out.ok).toBe(false)
    expect(out.error).toBe('LLM timeout')
    expect(out.workflow?.id).toBe('wf-1')
  })

  it('derives generated-strict from provenance when the save left the mode unset', async () => {
    runUnattendedPrompt.mockResolvedValue({ ok: true, answer: 'done' })
    composeWorkflowFromDraft.mockResolvedValue({
      // The shape a real generated save produces: provenance set, no explicit
      // mode. Reporting the raw field would claim `compat` for a graph the
      // engine replays under the strict regime.
      workflow: savedWorkflow({ settings: { provenance: 'chat-generate' } as never }),
      saved: true,
    })

    const out = await generateWorkflowUnattended({ prompt: 'x' }, 'external-gen:6')

    expect(out.workflow?.reliabilityMode).toBe('generated-strict')
  })

  it('defaults the reported reliability mode to compat when the save left it unset', async () => {
    runUnattendedPrompt.mockResolvedValue({ ok: true, answer: 'done' })
    composeWorkflowFromDraft.mockResolvedValue({
      workflow: savedWorkflow({ settings: {} as never }),
      saved: false,
    })

    const out = await generateWorkflowUnattended({ prompt: 'x' }, 'external-gen:5')

    expect(out.workflow).toMatchObject({
      reliabilityMode: 'compat',
      saveWarnings: [],
      saved: false,
    })
  })

  it('reports whether the saved graph was actually verified runnable', async () => {
    runUnattendedPrompt.mockResolvedValue({ ok: true, answer: 'done' })
    composeWorkflowFromDraft.mockResolvedValue({
      workflow: savedWorkflow({
        settings: {
          ...savedWorkflow().settings,
          pageContext: {
            origin: 'https://creator.xiaohongshu.com',
            additionalOrigins: ['https://github.com'],
          },
          trialRun: {
            outcome: 'failed',
            at: 1,
            full: false,
            coveredSteps: 1,
            totalSteps: 22,
            failureCode: 'WRONG_ORIGIN',
            reason: '导航目标（https://github.com）不是该工作流的目标站点',
          } as never,
        },
      }),
      saved: true,
    })

    const out = await generateWorkflowUnattended({ prompt: 'x' }, 'external-gen:6')

    // Saved is not verified: a caller that read one as the other would be told
    // the graph runs when its own replay died on step 1.
    expect(out.ok).toBe(true)
    expect(out.workflow).toMatchObject({
      saved: true,
      verified: false,
      pageContext: {
        origin: 'https://creator.xiaohongshu.com',
        additionalOrigins: ['https://github.com'],
      },
    })
    expect(out.workflow?.verification).toContain('failed WRONG_ORIGIN')
    expect(out.workflow?.verification).toContain('1/22')
  })

  it('counts a clean full replay as verified, and a partial one as not', async () => {
    runUnattendedPrompt.mockResolvedValue({ ok: true, answer: 'done' })
    const passed = savedWorkflow()
    composeWorkflowFromDraft.mockResolvedValue({ workflow: passed, saved: true })
    expect(
      (await generateWorkflowUnattended({ prompt: 'x' }, 'external-gen:7')).workflow?.verified,
    ).toBe(true)

    const partial = savedWorkflow({
      settings: {
        ...passed.settings,
        trialRun: {
          outcome: 'partial',
          at: 1,
          full: false,
          coveredSteps: 3,
          totalSteps: 5,
        } as never,
      },
    })
    composeWorkflowFromDraft.mockResolvedValue({ workflow: partial, saved: true })
    expect(
      (await generateWorkflowUnattended({ prompt: 'x' }, 'external-gen:8')).workflow?.verified,
    ).toBe(false)
  })
})

describe('startGenerationRun / readGenerationRun', () => {
  it('hands back a handle before the turn has finished', async () => {
    let finish: ((value: { ok: boolean; answer: string }) => void) | undefined
    runUnattendedPrompt.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    composeWorkflowFromDraft.mockResolvedValue({ workflow: savedWorkflow(), saved: true })
    hydrateDraft.mockResolvedValue(draft(2))

    const handle = startGenerationRun({ prompt: 'x' })
    // Returning here is the whole point: the caller gets the id while the turn
    // is still running, so the bridge never sits on a request past its timeout.
    expect(handle).toMatchObject({ status: 'running' })
    expect(handle.conversationId).toMatch(/^external-gen:/)

    const running = await readGenerationRun(handle.conversationId)
    expect(running).toMatchObject({
      conversationId: handle.conversationId,
      status: 'running',
      nodes: 2,
    })
    expect(running.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(running.result).toBeUndefined()

    finish?.({ ok: true, answer: 'done' })
    await flush()

    const settled = await readGenerationRun(handle.conversationId)
    expect(settled.status).toBe('settled')
    expect(settled.result).toMatchObject({ ok: true, conversationId: handle.conversationId })
    // Once the draft is closed, the saved graph is the node count.
    expect(settled.nodes).toBe(3)
  })

  it('settles a run whose turn threw instead of leaving it running', async () => {
    runUnattendedPrompt.mockRejectedValue(new Error('provider exploded'))

    const handle = startGenerationRun({ prompt: 'x' })
    await flush()

    const settled = await readGenerationRun(handle.conversationId)
    expect(settled.status).toBe('settled')
    expect(settled.result).toMatchObject({ ok: false, error: 'provider exploded' })
  })

  it('reports an id it has never started', async () => {
    expect(await readGenerationRun('external-gen:nope')).toMatchObject({
      status: 'unknown',
      nodes: 0,
    })
  })
})

describe('verifySavedWorkflowUnattended', () => {
  /** A replay record, shaped the way `runGenerationTrial` writes one. */
  function record(overrides: Record<string, unknown>) {
    return { at: 9, durationMs: 1200, ...overrides } as never
  }

  it('judges the GOAL after a replay that ran to the end, and reports it apart from coverage', async () => {
    // The round-9 graph is the case this exists for: 13 steps, every one of them
    // `ok`, and three leftover diagnostics at the tail — it replayed perfectly and
    // never saved a draft. `verified` alone could not tell those two stories
    // apart, so the L1/L2/L3 certification now comes back as its own field and
    // decides `certificationStatus` the way the panel's run button does.
    const stored = savedWorkflow({
      settings: {
        ...savedWorkflow().settings,
        goalSpec: { summary: 'A draft is saved.', successConditions: [] } as never,
      },
    })
    getWorkflow.mockResolvedValue(stored)
    trialRunner.mockResolvedValue({
      workflow: stored,
      record: record({ outcome: 'passed', full: true, coveredSteps: 3, totalSteps: 3 }),
      result: { runId: 'r9', outcome: 'ok' } as never,
    })
    verifyWorkflowGoal.mockResolvedValue({
      level: 'L3',
      certified: false,
      reason: 'L3 failed: every success condition holds from the page the workflow opens.',
      l3: {
        goalSummary: 'A draft is saved.',
        conditions: [
          { description: 'URL 包含 /publish', satisfied: true },
          { description: '元素可见「草稿」', satisfied: false, detail: '未找到该元素' },
        ],
        allHeld: false,
      },
    })

    const out = await verifySavedWorkflowUnattended({ workflowId: 'wf-1' }, 'external-verify:9')

    expect(out.workflow?.goal).toMatchObject({
      certified: false,
      level: 'L3',
      reason: expect.stringContaining('holds from the page'),
      // WHICH row failed, not just which layer: `reason` says L3, `unmet` names
      // the condition, and only the second one tells a repair what to aim at.
      unmet: ['元素可见「草稿」 — 未找到该元素'],
    })
    expect(out.workflow?.verified).toBe(true)
    expect(out.ok).toBe(true)
    expect(saveWorkflow.mock.lastCall?.[0]).toMatchObject({
      settings: { certificationStatus: 'unverified' },
    })
  })

  it('says before the replay that the graph has no step saving the draft it asked for', async () => {
    // Round 22 replayed 26/26 clean, `verified: true`, and wrote nothing, because
    // the step the user named was never in the graph. That is knowable the moment
    // the graph exists, so it is said then — not after twelve minutes of replay
    // that cannot discover it.
    const draftGoal = {
      summary: '生成图文草稿',
      successConditions: [{ kind: 'urlContains', value: 'xiaohongshu.com' }] as never,
    }
    const stored = savedWorkflow({
      settings: { ...savedWorkflow().settings, goalSpec: draftGoal },
    })
    getWorkflow.mockResolvedValue(stored)
    trialRunner.mockResolvedValue({
      workflow: stored,
      record: record({ outcome: 'passed', full: true, coveredSteps: 3, totalSteps: 3 }),
      result: { runId: 'r11', outcome: 'ok' } as never,
    })
    verifyWorkflowGoal.mockResolvedValue({
      level: 'L3',
      certified: true,
      reason: 'L3 passed: the workflow achieved its goal.',
      l3: { goalSummary: '生成图文草稿', conditions: [{ description: 'URL 命中', satisfied: true }], allHeld: true },
    })

    expect((await verifySavedWorkflowUnattended({ workflowId: 'wf-1' }, 'external-verify:11')).workflow?.terminalStepMissing).toBe(
      true,
    )

    // The same goal on a graph that DOES contain its terminal action says nothing.
    const withSave = savedWorkflow({
      settings: { ...savedWorkflow().settings, goalSpec: draftGoal },
      drawflow: {
        nodes: [
          {
            id: 'n1',
            data: {
              blockId: 'event-click',
              __reliability: { intent: '把笔记保存为草稿，不发布', idempotency: 'unsafe' },
            },
          },
        ] as never,
        edges: [] as never,
      },
    })
    getWorkflow.mockResolvedValue(withSave)
    trialRunner.mockResolvedValue({
      workflow: withSave,
      record: record({ outcome: 'passed', full: true, coveredSteps: 1, totalSteps: 1 }),
      result: { runId: 'r12', outcome: 'ok' } as never,
    })

    const ok = await verifySavedWorkflowUnattended({ workflowId: 'wf-1' }, 'external-verify:12')
    expect(ok.workflow?.terminalStepMissing).toBeUndefined()
  })

  it('leaves the goal unjudged when the replay did not run the whole graph', async () => {
    // A cutoff prefix deliberately left the last steps unexecuted; reporting its
    // goal as unmet would punish the safety rule that stopped it, and reporting
    // it as met would be the fake success this field exists to expose.
    const stored = savedWorkflow({
      settings: {
        ...savedWorkflow().settings,
        goalSpec: { summary: 'A draft is saved.', successConditions: [] } as never,
      },
    })
    getWorkflow.mockResolvedValue(stored)
    trialRunner.mockResolvedValue({
      workflow: stored,
      record: record({ outcome: 'partial', coveredSteps: 2, totalSteps: 3 }),
      result: { runId: 'r10', outcome: 'ok', stoppedBefore: 'n3' } as never,
    })

    const out = await verifySavedWorkflowUnattended({ workflowId: 'wf-1' }, 'external-verify:10')

    expect(out.workflow?.goal).toBeUndefined()
    expect(verifyWorkflowGoal).not.toHaveBeenCalled()
  })

  it('replays the stored graph under the verification budget and persists the fresh record', async () => {
    const stored = savedWorkflow()
    getWorkflow.mockResolvedValue(stored)
    trialRunner.mockResolvedValue({
      workflow: stored,
      record: record({ outcome: 'passed', full: true, coveredSteps: 3, totalSteps: 3 }),
    })

    const out = await verifySavedWorkflowUnattended(
      { workflowId: 'wf-1', scopeWindowId: 42 },
      'external-verify:1',
    )

    expect(getWorkflow).toHaveBeenCalledWith('wf-1')
    expect(trialRunner).toHaveBeenCalledWith(stored)
    // A replay the caller asked for gets the long budget, not the pre-save
    // trial's tight one: cutting a cold graph off early reports `timeout` for a
    // workflow that runs.
    const [trialArg] = createTrialRunner.mock.lastCall as [
      { scopeWindowId?: number; budgetMs?: number },
    ]
    expect(trialArg).toMatchObject({ scopeWindowId: 42, budgetMs: VERIFY_BUDGET_MS })

    expect(out).toMatchObject({ ok: true, conversationId: 'external-verify:1' })
    expect(out.workflow).toMatchObject({ id: 'wf-1', saved: true, verified: true })
    const [persisted] = saveWorkflow.mock.lastCall as [Workflow]
    expect(persisted.settings.trialRun).toMatchObject({ outcome: 'passed', coveredSteps: 3, at: 9 })
  })

  it('hands the replay the declared inputs the caller supplied', async () => {
    // A graph that searches for `{{keyword}}` is parameterised: the panel asks a
    // human, an unattended replay has to be told. One field covers a repair too,
    // because the repair's second replay reads this same request.
    const stored = savedWorkflow()
    getWorkflow.mockResolvedValue(stored)
    trialRunner.mockResolvedValue({
      workflow: stored,
      record: record({ outcome: 'passed', full: true, coveredSteps: 3, totalSteps: 3 }),
    })

    await verifySavedWorkflowUnattended(
      { workflowId: 'wf-1', inputs: { topic: '周末探店' } },
      'external-verify:9',
    )

    const [trialArg] = createTrialRunner.mock.lastCall as [{ inputs?: Record<string, unknown> }]
    expect(trialArg.inputs).toEqual({ topic: '周末探店' })
  })

  it('reports a graph that no longer runs as a failure, over the pass it was saved with', async () => {
    // The stored record says `passed` — generation proved it once. Reporting
    // that stale pass would be the exact wrong answer to "does it still run?".
    const stored = savedWorkflow()
    getWorkflow.mockResolvedValue(stored)
    trialRunner.mockResolvedValue({
      workflow: stored,
      record: record({
        outcome: 'failed',
        full: false,
        coveredSteps: 1,
        totalSteps: 22,
        failureCode: 'READINESS_TIMEOUT(present)',
        reason: '元素未出现',
      }),
    })

    const out = await verifySavedWorkflowUnattended({ workflowId: 'wf-1' }, 'external-verify:2')

    expect(out.ok).toBe(false)
    expect(out.workflow?.verified).toBe(false)
    expect(out.workflow?.verification).toContain('failed READINESS_TIMEOUT(present)')
    expect(out.workflow?.verification).toContain('1/22')
    expect(out.workflow?.verification).toContain('元素未出现')
  })

  it('reads a replay that stopped at the unsafe cutoff as unproven, not as broken', async () => {
    const stored = savedWorkflow()
    getWorkflow.mockResolvedValue(stored)
    trialRunner.mockResolvedValue({
      workflow: stored,
      record: record({
        outcome: 'partial',
        full: false,
        coveredSteps: 41,
        totalSteps: 47,
        cutoffNodeId: 'n42',
      }),
    })

    const out = await verifySavedWorkflowUnattended({ workflowId: 'wf-1' }, 'external-verify:3')

    expect(out.ok).toBe(true)
    expect(out.workflow?.verified).toBe(false)
    expect(out.workflow?.verification).toBe('partial (41/47 steps)')
  })

  it('refuses an id that is not in storage instead of replaying nothing', async () => {
    getWorkflow.mockResolvedValue(undefined)

    const out = await verifySavedWorkflowUnattended({ workflowId: 'nope' }, 'external-verify:4')

    expect(out).toMatchObject({ ok: false, conversationId: 'external-verify:4' })
    expect(out.error).toContain('nope')
    expect(trialRunner).not.toHaveBeenCalled()
    expect(saveWorkflow).not.toHaveBeenCalled()
  })

  it('honours a caller-supplied budget', async () => {
    getWorkflow.mockResolvedValue(savedWorkflow())
    trialRunner.mockResolvedValue({
      workflow: savedWorkflow(),
      record: record({ outcome: 'passed', full: true, coveredSteps: 3, totalSteps: 3 }),
    })

    await verifySavedWorkflowUnattended(
      { workflowId: 'wf-1', budgetMs: 20_000 },
      'external-verify:5',
    )

    const [trialArg] = createTrialRunner.mock.lastCall as [{ budgetMs?: number }]
    expect(trialArg.budgetMs).toBe(20_000)
  })
})

describe('startVerificationRun', () => {
  it('hands back a handle before the replay has finished, then settles with the verdict', async () => {
    let finish: ((value: { workflow: Workflow; record: unknown }) => void) | undefined
    getWorkflow.mockResolvedValue(savedWorkflow())
    trialRunner.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )

    const handle = startVerificationRun({ workflowId: 'wf-1' })
    expect(handle).toMatchObject({ status: 'running' })
    expect(handle.conversationId).toMatch(/^external-verify:/)

    // A replay records no draft, so there is no live node count to report.
    const running = await readGenerationRun(handle.conversationId)
    expect(running).toMatchObject({ status: 'running', nodes: 0 })

    finish?.({
      workflow: savedWorkflow(),
      record: { at: 9, outcome: 'passed', full: true, coveredSteps: 3, totalSteps: 3 },
    })
    await flush()

    const settled = await readGenerationRun(handle.conversationId)
    expect(settled.status).toBe('settled')
    expect(settled.nodes).toBe(3)
    expect(settled.result?.workflow).toMatchObject({ id: 'wf-1', verified: true })
  })
})

describe('repairSavedWorkflowUnattended', () => {
  const failing = {
    outcome: 'failed',
    full: false,
    coveredSteps: 2,
    totalSteps: 3,
    failedNodeId: 'n2',
    failureCode: 'LOCATOR_NOT_FOUND',
    reason: '元素未出现',
    runId: 'run-77',
  }
  const passing = {
    outcome: 'passed',
    full: true,
    coveredSteps: 3,
    totalSteps: 3,
    runId: 'run-78',
  }

  function repairArgs(): [
    {
      runId: string
      failure: unknown
      model?: unknown
      scopeWindowId?: number
      save: Record<string, Function>
    },
  ] {
    return startBackgroundAutoRepair.mock.lastCall as never
  }

  it('reports a graph that already runs without touching the repair loop', async () => {
    getWorkflow.mockResolvedValue(savedWorkflow())
    trialRunner.mockResolvedValue({
      workflow: savedWorkflow(),
      record: { at: 9, ...passing },
    })

    const out = await repairSavedWorkflowUnattended({ workflowId: 'wf-1' }, 'external-repair:1')

    expect(out.ok).toBe(true)
    expect(out.repair).toMatchObject({ attempted: false, status: 'not-needed', attempts: 0 })
    expect(startBackgroundAutoRepair).not.toHaveBeenCalled()
  })

  it('repairs a failed replay and reports the replay AFTER the repair', async () => {
    getWorkflow.mockResolvedValue(savedWorkflow())
    trialRunner
      .mockResolvedValueOnce({ workflow: savedWorkflow(), record: { at: 9, ...failing } })
      .mockResolvedValueOnce({ workflow: savedWorkflow(), record: { at: 20, ...passing } })
    startBackgroundAutoRepair.mockResolvedValue({
      status: 'success',
      attempts: 2,
      durationMs: 4_500,
      committed: true,
    })

    const out = await repairSavedWorkflowUnattended(
      {
        workflowId: 'wf-1',
        scopeWindowId: 42,
        model: { apiKey: 'k', baseUrl: 'https://x', model: 'm' },
      },
      'external-repair:2',
    )

    // The repair is handed the run that failed, whose evidence the trial
    // remembered, plus the caller's model and window.
    const [input] = repairArgs()
    expect(input).toMatchObject({ runId: 'run-77', scopeWindowId: 42 })
    expect(input.model).toMatchObject({ apiKey: 'k', model: 'm' })
    expect(input.failure).toMatchObject({ nodeId: 'n2' })
    expect(failureSnapshotForRun).toHaveBeenCalled()
    // The loop writes through the caller's save adapter, so a committed repair
    // lands in the same storage the panel reads.
    expect(typeof input.save.saveWorkflow).toBe('function')
    expect(typeof input.save.getWorkflow).toBe('function')

    expect(out.ok).toBe(true)
    expect(out.repair).toMatchObject({
      attempted: true,
      status: 'success',
      attempts: 2,
      durationMs: 4_500,
      committed: true,
      // What the loop was given to work from, kept beside its own verdict.
      failedNodeId: 'n2',
      failureCode: 'LOCATOR_NOT_FOUND',
    })
    expect(out.workflow?.trialRun).toMatchObject({ outcome: 'passed' })
    expect(out.workflow?.verified).toBe(true)
  })

  it('says so when the repair ran out of candidates', async () => {
    getWorkflow.mockResolvedValue(savedWorkflow())
    trialRunner.mockResolvedValue({ workflow: savedWorkflow(), record: { at: 9, ...failing } })
    startBackgroundAutoRepair.mockResolvedValue({
      status: 'exhausted',
      reason: 'no candidate passed verification',
      attempts: 3,
      durationMs: 9_000,
      committed: false,
    })

    const out = await repairSavedWorkflowUnattended({ workflowId: 'wf-1' }, 'external-repair:3')

    expect(out.ok).toBe(false)
    expect(out.repair).toMatchObject({
      attempted: true,
      status: 'exhausted',
      attempts: 3,
      committed: false,
      reason: 'no candidate passed verification',
    })
    // Still measured twice: the caller sees the same failing replay it started with.
    expect(trialRunner).toHaveBeenCalledTimes(2)
  })

  it('reports a failure it has no evidence for as blocked, not as repaired', async () => {
    // The service worker restarted between the replay and this call, so the
    // remembered trace is gone — repair cannot start without it.
    getWorkflow.mockResolvedValue(savedWorkflow())
    trialRunner.mockResolvedValue({ workflow: savedWorkflow(), record: { at: 9, ...failing } })
    failureSnapshotForRun.mockImplementation(() => {
      throw new Error('No failure evidence for run run-77.')
    })

    const out = await repairSavedWorkflowUnattended({ workflowId: 'wf-1' }, 'external-repair:4')

    expect(out.ok).toBe(false)
    expect(out.repair).toMatchObject({
      attempted: false,
      status: 'blocked',
      reason: 'No failure evidence for run run-77.',
      failedNodeId: 'n2',
    })
    expect(trialRunner).toHaveBeenCalledTimes(1)
  })

  it('does not repair a replay that timed out or never ran', async () => {
    // A slow page and a page that refused to open are not broken graphs; the
    // loop would spend a model call on each attempt to fix nothing.
    for (const outcome of ['timeout', 'skipped', 'partial'] as const) {
      trialRunner.mockReset().mockResolvedValue({
        workflow: savedWorkflow(),
        record: { at: 9, outcome, full: false, coveredSteps: 1, totalSteps: 3 },
      })
      getWorkflow.mockResolvedValue(savedWorkflow())

      const out = await repairSavedWorkflowUnattended(
        { workflowId: 'wf-1' },
        `external-repair:${outcome}`,
      )

      expect(out.ok).toBe(true)
      expect(out.repair?.status).toBe('not-needed')
    }
    expect(startBackgroundAutoRepair).not.toHaveBeenCalled()
  })
})

describe('startRepairRun', () => {
  it('hands back a handle before the replay has finished, then settles with the verdict', async () => {
    let firstSettled = false
    getWorkflow.mockResolvedValue(savedWorkflow())
    trialRunner.mockImplementation(
      () =>
        new Promise((resolve) => {
          if (!firstSettled) {
            firstSettled = true
            resolve({
              workflow: savedWorkflow(),
              record: {
                at: 9,
                outcome: 'failed',
                full: false,
                coveredSteps: 1,
                totalSteps: 3,
                failedNodeId: 'n2',
                runId: 'run-77',
              },
            })
            return
          }
          setTimeout(
            () =>
              resolve({
                workflow: savedWorkflow(),
                record: { at: 20, outcome: 'passed', full: true, coveredSteps: 3, totalSteps: 3 },
              } as never),
            0,
          )
        }),
    )
    startBackgroundAutoRepair.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                status: 'success',
                attempts: 1,
                durationMs: 1_200,
                committed: true,
              }),
            5,
          )
        }),
    )

    const handle = startRepairRun({ workflowId: 'wf-1' })
    expect(handle.conversationId).toMatch(/^external-repair:/)

    const running = await readGenerationRun(handle.conversationId)
    expect(running).toMatchObject({ status: 'running', nodes: 0 })
    expect(autoRepairEvents).toHaveBeenCalledWith('wf-1')

    // The repair loop is in flight: its event count is the only progress a
    // poller has between "still measuring" and "actually repairing".
    await new Promise((resolve) => setTimeout(resolve, 2))
    autoRepairEvents.mockReturnValue([{ type: 'repair.started' }])
    const repairing = await readGenerationRun(handle.conversationId)
    expect(repairing).toMatchObject({ status: 'running', nodes: 1 })

    await new Promise((resolve) => setTimeout(resolve, 40))
    await flush()

    const settled = await readGenerationRun(handle.conversationId)
    expect(settled.status).toBe('settled')
    expect(settled.result?.ok).toBe(true)
    expect(settled.result?.repair).toMatchObject({
      attempted: true,
      status: 'success',
      attempts: 1,
      committed: true,
    })
    expect(settled.result?.workflow?.verified).toBe(true)
  })
})

/**
 * The tab janitor an unattended run opts into.
 *
 * A replay of a graph that navigates leaves its page on screen, and a self test
 * that re-runs it twenty times leaves twenty — with nobody there to close them.
 * So the cleanup is opt-in, appearance-attributed (a tab that predates the run is
 * never closed), and it belongs to the run as a WHOLE: a repair loop reads the
 * page its own first replay left, so closing between the two would destroy the
 * evidence mid-investigation.
 */
describe('closeTabsAtEnd', () => {
  const PUBLISH = 'https://creator.xiaohongshu.com/publish/publish?target=image'
  const passing = { at: 9, outcome: 'passed', full: true, coveredSteps: 3, totalSteps: 3 }
  const failing = {
    at: 9,
    outcome: 'failed',
    full: false,
    coveredSteps: 1,
    totalSteps: 3,
    failedNodeId: 'n2',
    failureCode: 'LOCATOR_NOT_FOUND',
    runId: 'run-77',
  }

  function replayOpens(id: number, url = PUBLISH, windowId = 42) {
    getWorkflow.mockResolvedValue(savedWorkflow())
    trialRunner.mockImplementation(async () => {
      tabs.open({ id, windowId, url })
      return { workflow: savedWorkflow(), record: { ...passing } } as never
    })
  }

  let tabs: ReturnType<typeof makeTabs>
  beforeEach(() => {
    tabs = makeTabs([
      { id: 1, windowId: 42, url: 'https://creator.xiaohongshu.com/publish/publish?target=image' },
    ])
    vi.stubGlobal('chrome', { tabs: tabs.api })
  })

  it('does not touch a single tab when the caller did not ask', async () => {
    // The panel's own run path and every human-driven call land here: a run that
    // closes the page it just demonstrated would be a regression for them.
    getWorkflow.mockResolvedValue(undefined)
    const out = await verifySavedWorkflowUnattended({ workflowId: 'nope' }, 'external-verify:off')

    expect(out.tabsClosed).toBeUndefined()
    expect(tabs.api.query).not.toHaveBeenCalled()
    expect(tabs.api.remove).not.toHaveBeenCalled()
  })

  it('closes the page the replay opened and reports how many', async () => {
    replayOpens(2)

    const out = await verifySavedWorkflowUnattended(
      { workflowId: 'wf-1', scopeWindowId: 42, closeTabsAtEnd: true },
      'external-verify:1',
    )

    expect(out.tabsClosed).toBe(1)
    expect(tabs.removed()).toEqual([2])
  })

  it('leaves every tab that predates the run, in any window', async () => {
    tabs.open({ id: 50, windowId: 7, url: 'https://example.com/another-window' })
    replayOpens(2)

    await verifySavedWorkflowUnattended(
      { workflowId: 'wf-1', closeTabsAtEnd: true },
      'external-verify:2',
    )

    // Unscoped, the janitor still cannot invent blame: only tab 2 appeared.
    expect(tabs.removed()).toEqual([2])
    expect(tabs.live()).toContain(50)
  })

  it('leaves a pinned tab and a non-web tab alone even when the run opened them', async () => {
    getWorkflow.mockResolvedValue(savedWorkflow())
    trialRunner.mockImplementation(async () => {
      tabs.open({ id: 2, windowId: 42, url: PUBLISH, pinned: true })
      tabs.open({ id: 3, windowId: 42, url: 'chrome://extensions/' })
      tabs.open({ id: 4, windowId: 42, url: 'chrome-extension://abc/index.html' })
      return { workflow: savedWorkflow(), record: { ...passing } } as never
    })

    const out = await verifySavedWorkflowUnattended(
      { workflowId: 'wf-1', scopeWindowId: 42, closeTabsAtEnd: true },
      'external-verify:3',
    )

    expect(out.tabsClosed).toBe(0)
    expect(tabs.live()).toEqual([1, 2, 3, 4])
  })

  it('stays inside the window the run was assigned to', async () => {
    tabs.open({ id: 50, windowId: 7, url: 'https://example.com/not-mine' })
    replayOpens(2)

    await verifySavedWorkflowUnattended(
      { workflowId: 'wf-1', scopeWindowId: 42, closeTabsAtEnd: true },
      'external-verify:4',
    )

    expect(tabs.api.query).toHaveBeenCalledWith({ windowId: 42 })
    expect(tabs.removed()).toEqual([2])
    expect(tabs.live()).toContain(50)
  })

  it('keeps the page open while the repair loop reads it, then closes it once', async () => {
    getWorkflow.mockResolvedValue(savedWorkflow())
    trialRunner
      .mockImplementationOnce(async () => {
        tabs.open({ id: 2, windowId: 42, url: PUBLISH })
        return { workflow: savedWorkflow(), record: { ...failing } } as never
      })
      .mockImplementationOnce(async () => ({
        workflow: savedWorkflow(),
        record: { ...passing, at: 20 },
      }))
    let liveWhileRepairing: number[] = []
    startBackgroundAutoRepair.mockImplementation(async () => {
      liveWhileRepairing = tabs.live()
      return { status: 'success', attempts: 1, durationMs: 10, committed: true }
    })

    const out = await repairSavedWorkflowUnattended(
      { workflowId: 'wf-1', scopeWindowId: 42, closeTabsAtEnd: true },
      'external-repair:1',
    )

    // The evidence page was still there when the loop looked at it.
    expect(liveWhileRepairing).toEqual([1, 2])
    expect(out.tabsClosed).toBe(1)
    expect(tabs.removed()).toEqual([2])
  })

  it('cleans up a run that threw, and still reports the run as failed', async () => {
    getWorkflow.mockResolvedValue(savedWorkflow())
    trialRunner.mockImplementation(async () => {
      tabs.open({ id: 2, windowId: 42, url: PUBLISH })
      throw new Error('replay exploded')
    })

    await expect(
      verifySavedWorkflowUnattended(
        { workflowId: 'wf-1', scopeWindowId: 42, closeTabsAtEnd: true },
        'external-verify:5',
      ),
    ).rejects.toThrow('replay exploded')

    expect(tabs.removed()).toEqual([2])
  })
})
