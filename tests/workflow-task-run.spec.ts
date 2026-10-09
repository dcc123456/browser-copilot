import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../src/lib/scheduler-types'
import type { Workflow } from '../src/lib/workflow/types'

/**
 * A workflow-kind scheduled task used to open TWO tracked runs — the task
 * wrapper in `task-runner` and the engine's own run inside `executeWorkflow`.
 * The task's run log therefore held only its two "starting" lines while the
 * real steps lived on a second record that a concurrent write could drop, so a
 * scheduled workflow could look like it never ran. These tests pin the fix: the
 * engine records onto the run the task already opened.
 */
const engine = vi.hoisted(() => ({ runWorkflow: vi.fn() }))
vi.mock('../src/background/workflow-engine/engine', () => ({
  runWorkflow: engine.runWorkflow,
}))
vi.mock('../src/background/driver', () => ({
  countElements: vi.fn(async () => 0),
  execJsOnActiveTab: vi.fn(async () => ({ ok: true, data: undefined })),
}))
vi.mock('../src/background/automation-scope', () => ({
  normalScopeFromWindowId: vi.fn(async () => undefined),
}))
vi.mock('../src/lib/workflow/blocks/palette', () => ({
  BLOCK_BY_ID: new Map(),
  PALETTE_BLOCKS: [],
}))

// task-runner's other dependencies, so importing it stays cheap and inert.
const deps = vi.hoisted(() => ({
  getWorkflow: vi.fn(),
  executeWorkflow: vi.fn(),
  resolveUnattendedScope: vi.fn(async () => undefined),
  recordTaskRun: vi.fn(async () => {}),
  getFeishuConfig: vi.fn(async () => ({ webhookUrl: '', webhookSecret: '' })),
  getTask: vi.fn(async () => undefined as unknown),
  listRuns: vi.fn(async () => [] as unknown[]),
}))
vi.mock('../src/lib/workflow/storage', () => ({ getWorkflow: deps.getWorkflow }))
vi.mock('../src/background/workflow-engine/run-workflow', () => ({
  executeWorkflow: deps.executeWorkflow,
}))
vi.mock('../src/background/window-policy', () => ({
  resolveUnattendedScope: deps.resolveUnattendedScope,
}))
vi.mock('../src/lib/task-store', () => ({
  recordTaskRun: deps.recordTaskRun,
  getFeishuConfig: deps.getFeishuConfig,
  addRun: vi.fn(async () => ({})),
  getTask: deps.getTask,
  listRuns: deps.listRuns,
}))
vi.mock('../src/background/agent-unattended', () => ({
  runUnattendedPrompt: vi.fn(async () => ({ ok: true, answer: '' })),
}))
vi.mock('../src/lib/github', () => ({
  NotLoggedIn: class NotLoggedIn extends Error {},
  fetchReviewRequests: vi.fn(),
  formatReviewSummary: vi.fn(() => ({ headline: '', body: '' })),
}))
vi.mock('../src/lib/feishu', () => ({ sendWebhookText: vi.fn(async () => {}) }))

import { runTask } from '../src/background/task-runner'
import { addStep, listFinished } from '../src/background/running-tasks'

const workflow = {
  id: 'wf-soy',
  name: '豆奶签到',
  createdAt: 1,
  updatedAt: 1,
  drawflow: { nodes: [], edges: [] },
  settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
} as unknown as Workflow

function workflowTask(): ScheduledTask {
  return {
    id: 'task-soy',
    name: '豆奶签到',
    enabled: true,
    schedule: { kind: 'daily', hour: 10, minute: 0 },
    kind: 'workflow',
    workflowId: workflow.id,
    maxToolRounds: 50,
    notifyFeishu: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  deps.getWorkflow.mockResolvedValue(workflow)
  deps.resolveUnattendedScope.mockResolvedValue(undefined)
})

describe('scheduled workflow task', () => {
  it('records the engine steps on the task run instead of opening a second run', async () => {
    deps.executeWorkflow.mockImplementation(
      async (_wf: Workflow, opts: { reuseRun?: { runId: string } }) => {
        // Mirror the engine: write steps onto the run it was handed.
        expect(opts.reuseRun).toBeDefined()
        addStep(opts.reuseRun!.runId, 'status', '已点击签到')
        return { runId: opts.reuseRun!.runId, outcome: 'ok', summary: '签到完成' }
      },
    )

    const outcome = await runTask(workflowTask(), 'schedule', 'zh')
    expect(outcome.ok).toBe(true)

    const runs = listFinished().filter((run) => run.taskId === 'task-soy')
    expect(runs).toHaveLength(1)
    expect(runs[0]!.steps.map((step) => step.text)).toEqual([
      'Starting workflow task…',
      'Running workflow: 豆奶签到',
      '已点击签到',
    ])
  })

  it('labels a manual run of a workflow task as manual', async () => {
    deps.executeWorkflow.mockImplementation(async () => ({ runId: 'r', outcome: 'ok' }))
    await runTask(workflowTask(), 'manual', 'zh')
    expect(deps.executeWorkflow).toHaveBeenCalledWith(
      workflow,
      expect.objectContaining({ source: 'manual', taskId: 'task-soy' }),
    )
  })
})

/**
 * The chain half of a scheduled run: read what the parent published, and publish
 * what this run declares. The two "cannot run" shapes are deliberately different
 * — an early child waits quietly, a broken contract shouts.
 */
describe('chained workflow task', () => {
  function childTask(): ScheduledTask {
    return {
      ...workflowTask(),
      id: 'task-comment',
      name: 'Comment',
      followsTaskId: 'task-publish',
      variables: { note: '{{upstream.noteUrl}}' },
    }
  }

  beforeEach(() => {
    deps.getTask.mockResolvedValue({ id: 'task-publish', name: 'Publish', kind: 'workflow' })
  })

  it('resolves the parent outputs into the run inputs and hands its own on', async () => {
    deps.listRuns.mockResolvedValue([
      {
        id: 'r-parent',
        taskId: 'task-publish',
        at: 5,
        outcome: 'ok',
        summary: 'published',
        outputs: { noteUrl: 'https://x/1' },
      },
    ])
    deps.executeWorkflow.mockImplementation(
      async (_wf: Workflow, opts: { variables?: Record<string, unknown> }) => ({
        runId: 'r-child',
        outcome: 'ok',
        summary: 'replied to 3 comments',
        variables: { ...(opts.variables ?? {}), replyCount: 3 },
      }),
    )

    const outcome = await runTask({ ...childTask(), outputs: ['replyCount'] }, 'schedule', 'en')

    expect(outcome.ok).toBe(true)
    expect(deps.executeWorkflow).toHaveBeenCalledWith(
      workflow,
      expect.objectContaining({
        // The declared reference is filled in, and the parent's whole map is
        // seeded too, so a graph node can read {{upstream.noteUrl} itself.
        variables: {
          note: 'https://x/1',
          upstream: { noteUrl: 'https://x/1', summary: 'published' },
        },
      }),
    )
    expect(outcome.outputs).toEqual({ replyCount: 3 })
    expect(listFinished()[0]?.outputs).toEqual({ replyCount: 3 })
  })

  it('skips without touching the page while the parent has produced nothing', async () => {
    deps.listRuns.mockResolvedValue([
      { id: 'r-parent', taskId: 'task-publish', at: 1, outcome: 'failed', summary: 'boom' },
    ])

    const outcome = await runTask(childTask(), 'schedule', 'en')

    expect(outcome.skipped).toBe(true)
    expect(outcome.summary).toContain('Waiting upstream')
    expect(deps.executeWorkflow).not.toHaveBeenCalled()
    const record = listFinished()[0]
    expect(record?.outcome).toBe('skipped')
    expect(record?.steps.map((step) => step.text)).toEqual([
      expect.stringContaining('Waiting upstream'),
    ])
  })

  it('fails loudly when the parent ran fine but never carried the key', async () => {
    deps.listRuns.mockResolvedValue([
      {
        id: 'r-parent',
        taskId: 'task-publish',
        at: 1,
        outcome: 'ok',
        summary: 'published',
        outputs: { title: 'Note' },
      },
    ])

    const outcome = await runTask(childTask(), 'schedule', 'en')

    expect(outcome.ok).toBe(false)
    expect(outcome.skipped).toBe(false)
    expect(outcome.error).toContain('{{upstream.noteUrl}}')
    expect(outcome.error).toContain('title')
    expect(deps.executeWorkflow).not.toHaveBeenCalled()
  })

  it('fails loudly when the parent task was deleted', async () => {
    deps.getTask.mockResolvedValue(undefined)

    const outcome = await runTask(childTask(), 'schedule', 'en')

    expect(outcome.error).toContain('no longer exists')
    expect(deps.executeWorkflow).not.toHaveBeenCalled()
  })

  it('reports a declared output the run never produced, without failing the run', async () => {
    deps.listRuns.mockResolvedValue([])
    deps.executeWorkflow.mockResolvedValue({
      runId: 'r',
      outcome: 'ok',
      summary: 'posted',
      variables: { other: 1 },
    })

    const outcome = await runTask({ ...workflowTask(), outputs: ['noteUrl'] }, 'schedule', 'en')

    expect(outcome.ok).toBe(true)
    expect(outcome.outputs).toBeUndefined()
    const record = listFinished().find((run) => run.taskId === 'task-soy')
    expect(record?.steps.some((step) => step.kind === 'error')).toBe(true)
  })
})
