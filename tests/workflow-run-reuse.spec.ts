import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workflow } from '../src/lib/workflow/types'

/**
 * `executeWorkflow` normally opens its own tracked run. A scheduled
 * workflow-kind task already has one, and used to get a SECOND record whose
 * concurrent write could drop the first — leaving a run-log card with nothing
 * but the task wrapper's two "starting" lines. `reuseRun` makes the engine
 * record onto the caller's run and leave finishing to the caller.
 *
 * This suite uses the REAL `executeWorkflow`, so only its engine/driver edges
 * are mocked.
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
vi.mock('../src/lib/workflow/blocks/palette', () => ({ BLOCK_BY_ID: new Map() }))

import { executeWorkflow } from '../src/background/workflow-engine/run-workflow'
import { getRun, listRunning, startRun } from '../src/background/running-tasks'

const workflow = {
  id: 'wf-soy',
  name: '豆奶签到',
  createdAt: 1,
  updatedAt: 1,
  drawflow: {
    nodes: [
      { id: 'n1', label: 'click', position: { x: 0, y: 0 }, data: { blockId: 'click', description: '点击签到' } },
    ],
    edges: [],
  },
  settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
} as unknown as Workflow

beforeEach(() => {
  engine.runWorkflow.mockReset()
})

describe('executeWorkflow run ownership', () => {
  it('records on a reused run and leaves finishing to the caller', async () => {
    engine.runWorkflow.mockImplementation(
      async (_wf: Workflow, opts: { onStep: (kind: string, id: string, text: string) => void }) => {
        opts.onStep('tool', 'n1', '')
        opts.onStep('status', 'n1', '已点击签到')
        return { outcome: 'ok', completedNodeIds: ['n1'], summary: 'done' }
      },
    )
    const tracked = startRun({ label: '豆奶签到', source: 'schedule', taskId: 'task-soy' })

    const result = await executeWorkflow(workflow, {
      source: 'schedule',
      taskId: 'task-soy',
      reuseRun: tracked,
    })

    expect(result.runId).toBe(tracked.runId)
    const run = getRun(tracked.runId)
    // The editor's run logs are filtered by workflow id — the reused run must
    // carry it, even though the task runner opened the run without knowing it.
    expect(run?.workflowId).toBe(workflow.id)
    expect(run?.steps.map((step) => step.text)).toEqual(['click: 点击签到', '已点击签到'])
    // Not finished: the caller still owns the run and settles it itself.
    expect(listRunning().some((entry) => entry.runId === tracked.runId)).toBe(true)
  })

  it('owns and finishes its own run when none is reused', async () => {
    engine.runWorkflow.mockResolvedValue({ outcome: 'ok', completedNodeIds: [], summary: 'ok' })
    const result = await executeWorkflow(workflow, { source: 'schedule' })
    expect(getRun(result.runId)).toBeUndefined()
  })

  it('reports a failed engine result to the caller without finishing a reused run', async () => {
    engine.runWorkflow.mockResolvedValue({
      outcome: 'failed',
      completedNodeIds: [],
      summary: '没找到块执行器',
      error: '没找到块执行器: click',
    })
    const tracked = startRun({ label: '豆奶签到', source: 'schedule', taskId: 'task-soy' })
    const result = await executeWorkflow(workflow, { source: 'schedule', reuseRun: tracked })
    expect(result.outcome).toBe('failed')
    expect(result.error).toBe('没找到块执行器: click')
    expect(listRunning().some((entry) => entry.runId === tracked.runId)).toBe(true)
  })
})
