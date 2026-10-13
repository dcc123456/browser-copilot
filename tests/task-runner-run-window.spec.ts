/**
 * Tests for the run-window wiring in the scheduled-task runner.
 *
 * The lease itself is tested in tests/run-window-lease.spec.ts; what matters
 * here is that `runTask` actually uses it: browser-touching task kinds lease a
 * window before any work starts, pass that window down as the run's scope, and
 * close it in their `finally` — even when the work throws. Board-free task kinds
 * (the GitHub fetch) must stay out of this entirely, and a run that finds the
 * board free must behave exactly as it did before the feature existed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../src/lib/scheduler-types'
import type { Workflow } from '../src/lib/workflow/types'

const deps = vi.hoisted(() => ({
  getSettings: vi.fn(),
  runUnattendedPrompt: vi.fn(),
  executeWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  recordTaskRun: vi.fn(async () => {}),
  getTask: vi.fn(async () => undefined as unknown),
  listRuns: vi.fn(async () => [] as unknown[]),
  createRunWindow: vi.fn(),
  closeRunWindow: vi.fn(async () => {}),
  reclaimOrphanRunWindows: vi.fn(async () => [] as number[]),
  currentPluginScope: vi.fn(),
}))

vi.mock('../src/lib/storage', () => ({ getSettings: deps.getSettings, newId: () => 'id' }))
vi.mock('../src/lib/task-store', () => ({
  recordTaskRun: deps.recordTaskRun,
  getFeishuConfig: vi.fn(async () => ({ webhookUrl: '', webhookSecret: '' })),
  addRun: vi.fn(async () => ({})),
  getTask: deps.getTask,
  listRuns: deps.listRuns,
}))
vi.mock('../src/background/agent-unattended', () => ({
  runUnattendedPrompt: deps.runUnattendedPrompt,
}))
vi.mock('../src/lib/workflow/storage', () => ({ getWorkflow: deps.getWorkflow }))
vi.mock('../src/background/workflow-engine/run-workflow', () => ({
  executeWorkflow: deps.executeWorkflow,
}))
vi.mock('../src/lib/workflow/replay-metrics', () => ({
  observeFirstRunOfRevision: vi.fn(async () => undefined),
}))
vi.mock('../src/background/keepalive', () => ({ retain: vi.fn(), release: vi.fn() }))
vi.mock('../src/lib/github', () => ({
  NotLoggedIn: class NotLoggedIn extends Error {},
  fetchReviewRequests: vi.fn(),
  formatReviewSummary: vi.fn(() => ({ headline: '', body: '' })),
}))
vi.mock('../src/lib/feishu', () => ({ sendWebhookText: vi.fn(async () => {}) }))

// The lease layer runs for real on top of this chrome-free scope stub.
vi.mock('../src/background/automation-scope', () => ({
  closeRunWindow: deps.closeRunWindow,
  createRunWindow: deps.createRunWindow,
  currentPluginScope: deps.currentPluginScope,
  hasPanelWindows: () => true,
  isPluginWindow: () => true,
  latestPluginWindowId: () => 7,
  listNormalWindows: async () => [],
  normalScopeFromWindowId: async (windowId?: number) =>
    typeof windowId === 'number' ? { windowId } : undefined,
  reclaimOrphanRunWindows: deps.reclaimOrphanRunWindows,
}))

import { listFinished, listRunning } from '../src/background/running-tasks'
import { runTask } from '../src/background/task-runner'

const workflow = {
  id: 'wf-checkin',
  name: 'Check-in',
  createdAt: 1,
  updatedAt: 1,
  drawflow: { nodes: [], edges: [] },
  settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
} as unknown as Workflow

let taskSeq = 0

function promptTask(prompt = 'open the page'): ScheduledTask {
  taskSeq += 1
  return {
    id: `task-${taskSeq}`,
    name: `Task ${taskSeq}`,
    enabled: true,
    schedule: { kind: 'interval', minutes: 60 },
    kind: 'agent-prompt',
    prompt,
    maxToolRounds: 5,
    notifyFeishu: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

function workflowTask(): ScheduledTask {
  const task = promptTask()
  return { ...task, kind: 'workflow', prompt: undefined, workflowId: workflow.id }
}

/** The scope each mocked consumer was handed. */
function promptScopes(): (number | undefined)[] {
  return deps.runUnattendedPrompt.mock.calls.map(
    (call) => (call[3] as { scopeWindowId?: number }).scopeWindowId,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  deps.getSettings.mockResolvedValue({
    maxConcurrentRunWindows: 3,
    unattendedWindowPolicy: 'latest',
  })
  deps.currentPluginScope.mockResolvedValue({ windowId: 7 })
  deps.getWorkflow.mockResolvedValue(workflow)
  deps.runUnattendedPrompt.mockResolvedValue({ ok: true, answer: 'done' })
  deps.executeWorkflow.mockResolvedValue({ runId: 'r', outcome: 'ok', summary: 'done' })
  let nextWindowId = 100
  deps.createRunWindow.mockImplementation(async () => nextWindowId++)
})

describe('scheduled task run windows', () => {
  it('leaves a lone run on the shared window, as before', async () => {
    const outcome = await runTask(promptTask(), 'schedule', 'en')
    expect(outcome.ok).toBe(true)
    expect(deps.createRunWindow).not.toHaveBeenCalled()
    expect(promptScopes()).toEqual([undefined])
    expect(deps.closeRunWindow).not.toHaveBeenCalled()
    // The board still records which window it worked in, for the badge.
    expect(listFinished()[0]).toMatchObject({ windowId: 7, runWindowKind: 'shared' })
  })

  it('gives two runs firing in the same instant a window each', async () => {
    const [a, b] = await Promise.all([
      runTask(promptTask(), 'schedule', 'en'),
      runTask(promptTask(), 'schedule', 'en'),
    ])
    expect([a.ok, b.ok]).toEqual([true, true])

    // Which run gets tier 0 is a race, so compare the pair, not the order.
    expect([...promptScopes()].sort()).toEqual([100, 101])
    // Both windows are closed again on settle.
    expect(deps.closeRunWindow.mock.calls.flat().sort()).toEqual([100, 101])
    expect(listRunning()).toHaveLength(0)
    // Newest first: both of the two runs just finished carry their own window.
    expect(
      listFinished()
        .slice(0, 2)
        .map((run) => run.runWindowKind),
    ).toEqual(['dedicated', 'dedicated'])
  })

  it('scopes a workflow run to its own window and skips the policy lookup', async () => {
    const tasks = [workflowTask(), workflowTask()]
    await Promise.all(tasks.map((task) => runTask(task, 'schedule', 'en')))
    const scopeIds = deps.executeWorkflow.mock.calls.map(
      (call) => (call[1] as { scopeWindowId?: number }).scopeWindowId,
    )
    expect([...scopeIds].sort()).toEqual([100, 101])
  })

  it('uses the policy window for a workflow run when the board is free', async () => {
    await runTask(workflowTask(), 'schedule', 'en')
    const opts = deps.executeWorkflow.mock.calls[0]![1] as { scopeWindowId?: number }
    expect(opts.scopeWindowId).toBe(7)
    expect(deps.createRunWindow).not.toHaveBeenCalled()
  })

  it('closes nothing when a shared run throws', async () => {
    deps.runUnattendedPrompt.mockRejectedValue(new Error('model exploded'))
    const outcome = await runTask(promptTask(), 'schedule', 'en')
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('model exploded')
    // The run stayed on the shared window, so it has no window to close.
    expect(deps.closeRunWindow).not.toHaveBeenCalled()
  })

  it('closes the dedicated window when the work throws', async () => {
    // Hold one run on the shared window so the next is forced into its own.
    // Branching on the prompt, not on once-queues: which run reaches the tool
    // first is not fixed.
    let releaseHolder!: () => void
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve
    })
    deps.runUnattendedPrompt.mockImplementation(
      async (prompt: string): Promise<{ ok: boolean; answer: string }> => {
        if (prompt === 'hold') {
          await held
          return { ok: true, answer: 'done' }
        }
        throw new Error('model exploded')
      },
    )
    const holder = runTask(promptTask('hold'), 'schedule', 'en')
    await vi.waitFor(() => expect(listRunning()[0]?.windowId).toBe(7))

    const outcome = await runTask(promptTask(), 'schedule', 'en')
    expect(outcome.error).toBe('model exploded')
    expect(deps.createRunWindow).toHaveBeenCalledTimes(1)
    expect(deps.closeRunWindow.mock.calls).toEqual([[100]])

    releaseHolder()
    await holder
  })

  it('keeps browser-free task kinds out of the lease', async () => {
    const task = { ...promptTask(), kind: 'github-review-requests' } as ScheduledTask
    await runTask(task, 'schedule', 'en')
    expect(deps.createRunWindow).not.toHaveBeenCalled()
    expect(listFinished()[0]?.runWindowKind).toBeUndefined()
  })
})
