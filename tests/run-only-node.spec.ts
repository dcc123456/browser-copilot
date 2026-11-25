/**
 * A single-node test is a PARTIAL run: one operator cannot satisfy the whole
 * workflow goal, so the L3 gate must not run (it would turn a successful block
 * test into "goal not achieved"). These tests pin the orchestration layer
 * around the real `executeWorkflow` with only the engine and goal verifier
 * mocked, because the flags passed across that seam are exactly what decides
 * whether the node test keeps its own meaning.
 *
 * See specs/2026-11-25-run-current-node-design.md.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workflow } from '../src/lib/workflow/types'

const engine = vi.hoisted(() => ({ runWorkflow: vi.fn() }))
const goalVerifier = vi.hoisted(() => ({ verifyGoalSpec: vi.fn() }))
vi.mock('../src/background/workflow-engine/engine', () => ({ runWorkflow: engine.runWorkflow }))
vi.mock('../src/background/workflow-engine/goal-verifier', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/workflow-engine/goal-verifier')>()),
  verifyGoalSpec: goalVerifier.verifyGoalSpec,
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
  id: 'wf-node-test',
  name: 'node test',
  createdAt: 1,
  updatedAt: 1,
  drawflow: {
    nodes: [
      { id: 't', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger' } },
      { id: 'g', label: 'get-text', position: { x: 1, y: 0 }, data: { blockId: 'get-text' } },
    ],
    edges: [{ id: 'e1', source: 't', target: 'g' }],
  },
  settings: {
    saveLog: false,
    debugMode: false,
    notification: false,
    reuseLastState: false,
    goalSpec: { summary: 'the goal', successConditions: [{ kind: 'variableExists', name: 'x' }] },
  },
} as unknown as Workflow

beforeEach(() => {
  engine.runWorkflow.mockReset()
  goalVerifier.verifyGoalSpec.mockReset()
  engine.runWorkflow.mockResolvedValue({
    outcome: 'ok',
    completedNodeIds: ['g'],
    summary: 'block ran',
    trace: { nodes: [] },
  })
  goalVerifier.verifyGoalSpec.mockResolvedValue({ achieved: false, note: 'goal not achieved' })
})

describe('the single-node run orchestration', () => {
  it('passes onlyNode to the engine and skips the workflow goal gate', async () => {
    const tracked = startRun({ label: workflow.name, source: 'manual' })
    const result = await executeWorkflow(workflow, {
      source: 'manual',
      reuseRun: tracked,
      startAt: 'g',
      onlyNode: true,
    })
    expect(engine.runWorkflow.mock.calls[0]?.[1].onlyNode).toBe(true)
    expect(goalVerifier.verifyGoalSpec).not.toHaveBeenCalled()
    expect(result.outcome).toBe('ok')

    const steps = getRun(tracked.runId)?.steps ?? []
    expect(steps.some((step) => step.text.includes('仅运行当前节点'))).toBe(true)
  })

  it('still gates the workflow goal on a normal run', async () => {
    const tracked = startRun({ label: workflow.name, source: 'manual' })
    const result = await executeWorkflow(workflow, {
      source: 'manual',
      reuseRun: tracked,
      startAt: 'g',
    })
    expect(engine.runWorkflow.mock.calls[0]?.[1].onlyNode).toBeUndefined()
    expect(goalVerifier.verifyGoalSpec).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe('failed')
  })
})
