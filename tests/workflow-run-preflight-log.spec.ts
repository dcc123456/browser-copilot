/**
 * The manual run gate writes its findings onto the run.
 *
 * `workflows.run` used to `throw` before the engine started: no run, no log,
 * and a toast that pointed at a node the canvas could not scroll to. The gate's
 * findings now ride into `executeWorkflow` as `preflight`, land on the run log
 * (one row per node, carrying that node's id so the editor can locate it), and
 * become `preflightBlockers` for the engine to stop on. This suite runs the real
 * integration layer with only the engine mocked, because the row shapes are
 * exactly what the log modal and the canvas read.
 *
 * See specs/2026-10-06-run-preflight-log-design.md.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workflow } from '../src/lib/workflow/types'
import type { WorkflowRunIssue } from '../src/lib/workflow/validation'

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

import { executeWorkflow } from '../src/background/workflow-engine/run-workflow'
import { getRun, startRun } from '../src/background/running-tasks'

const workflow = {
  id: 'wf-drafts',
  name: '读取草稿箱',
  createdAt: 1,
  updatedAt: 1,
  drawflow: {
    nodes: [
      { id: 't', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger' } },
      {
        id: 'g',
        label: 'get-text',
        position: { x: 1, y: 0 },
        data: { blockId: 'get-text', selector: '', description: '读取草稿标题' },
      },
    ],
    edges: [],
  },
  settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
} as unknown as Workflow

const missingLocator: WorkflowRunIssue = {
  severity: 'error',
  nodeId: 'g',
  blockId: 'get-text',
  nodeName: 'Get text: 读取草稿标题',
  param: 'selector',
  message: '缺少必填参数 selector：缺少元素定位。',
}
const frozenLiteral: WorkflowRunIssue = {
  severity: 'warning',
  nodeId: 'g',
  blockId: 'new-tab',
  nodeName: 'Open new tab',
  param: 'url',
  message: 'url 是固定值 "https://x.test"：重放时不会变化。',
}
const noTrigger: WorkflowRunIssue = {
  severity: 'error',
  nodeName: '',
  message: '工作流缺少触发器：请添加一个 trigger 节点，否则无法运行',
}

beforeEach(() => {
  engine.runWorkflow.mockReset()
  engine.runWorkflow.mockResolvedValue({
    outcome: 'failed',
    completedNodeIds: ['t'],
    summary: 'stopped',
    error: missingLocator.message,
  })
})

describe('the preflight findings on the run log', () => {
  it('records a row per blocked node, tagged with that node', async () => {
    const tracked = startRun({ label: workflow.name, source: 'manual' })
    await executeWorkflow(workflow, {
      source: 'manual',
      reuseRun: tracked,
      preflight: [missingLocator, frozenLiteral],
    })
    const steps = getRun(tracked.runId)?.steps ?? []
    const blamed = steps.find((s) => s.kind === 'error' && s.nodeId === 'g')
    expect(blamed?.label).toBe('Get text: 读取草稿标题')
    expect(blamed?.text).toContain('Get text: 读取草稿标题')
    expect(blamed?.text).toContain('缺少必填参数 selector')
    // The count row comes first, so a reader sees how many are at fault.
    const summary = steps.findIndex((s) => s.text.startsWith('运行前检查：1 个算子'))
    expect(summary).toBeGreaterThanOrEqual(0)
    expect(summary).toBeLessThan(steps.indexOf(blamed!))
    // Warnings reach the log too — not just the console they used to die in.
    expect(steps.some((s) => s.kind === 'status' && s.text.includes('不阻止运行'))).toBe(true)
  })

  it('keeps a workflow-level finding in one row, without a node tag', async () => {
    const tracked = startRun({ label: workflow.name, source: 'manual' })
    await executeWorkflow(workflow, { source: 'manual', reuseRun: tracked, preflight: [noTrigger] })
    const steps = getRun(tracked.runId)?.steps ?? []
    const row = steps.find((s) => s.text.includes('缺少触发器'))
    expect(row?.kind).toBe('error')
    expect(row?.nodeId).toBeUndefined()
  })

  it('hands the engine one stop reason per node, without repeating its name', async () => {
    const tracked = startRun({ label: workflow.name, source: 'manual' })
    await executeWorkflow(workflow, {
      source: 'manual',
      reuseRun: tracked,
      preflight: [missingLocator, frozenLiteral],
    })
    expect(engine.runWorkflow.mock.calls[0]?.[1].preflightBlockers).toEqual({
      g: missingLocator.message,
    })
  })

  it('lists at most twenty blocked nodes and says how many more there are', async () => {
    const many: WorkflowRunIssue[] = Array.from({ length: 25 }, (_, i) => ({
      severity: 'error',
      nodeId: `n${i}`,
      blockId: 'get-text',
      nodeName: `Get text ${i}`,
      param: 'selector',
      message: '缺少必填参数 selector：缺少元素定位。',
    }))
    const tracked = startRun({ label: workflow.name, source: 'manual' })
    await executeWorkflow(workflow, { source: 'manual', reuseRun: tracked, preflight: many })
    const steps = getRun(tracked.runId)?.steps ?? []
    expect(steps.filter((s) => s.kind === 'error' && s.nodeId)).toHaveLength(20)
    expect(steps.some((s) => s.text.includes('另有 5 个算子'))).toBe(true)
  })

  it('leaves a run without preflight findings exactly as it was', async () => {
    const tracked = startRun({ label: workflow.name, source: 'schedule' })
    await executeWorkflow(workflow, { source: 'schedule', reuseRun: tracked })
    const steps = getRun(tracked.runId)?.steps ?? []
    expect(steps.some((s) => s.text.includes('运行前检查'))).toBe(false)
    expect(engine.runWorkflow.mock.calls[0]?.[1].preflightBlockers).toBeUndefined()
  })
})
