import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workflow } from '../src/lib/workflow/types'

const engine = vi.hoisted(() => ({ runWorkflow: vi.fn() }))
const storage = vi.hoisted(() => ({ getSettings: vi.fn() }))
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
vi.mock('../src/lib/storage', () => ({ getSettings: storage.getSettings }))

import { executeWorkflow } from '../src/background/workflow-engine/run-workflow'
import { getRun, startRun } from '../src/background/running-tasks'

const workflow = {
  id: 'wf-job',
  name: '岗位筛选',
  createdAt: 1,
  updatedAt: 1,
  drawflow: {
    nodes: [
      { id: 't', label: 'trigger', position: { x: 0, y: 0 }, data: { blockId: 'trigger' } },
      {
        id: 'g',
        label: 'get-text',
        position: { x: 1, y: 0 },
        data: { blockId: 'get-text', selector: '#company', description: '读取公司名' },
      },
    ],
    edges: [],
  },
  settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
} as unknown as Workflow

beforeEach(() => {
  engine.runWorkflow.mockReset()
  engine.runWorkflow.mockResolvedValue({
    outcome: 'success',
    completedNodeIds: ['t', 'g'],
    summary: 'ok',
  })
  storage.getSettings.mockReset()
  storage.getSettings.mockResolvedValue({
    jobBlacklist: {
      companies: ['Acme'],
      headhunterPositions: ['外包'],
      excludeHeadhunters: true,
    },
  })
})

describe('job blacklists on a run', () => {
  it('hands the CURRENT settings lists to the engine', async () => {
    const tracked = startRun({ label: workflow.name, source: 'manual' })
    await executeWorkflow(workflow, { source: 'manual', reuseRun: tracked })
    expect(engine.runWorkflow.mock.calls[0]?.[1].variables?.jobBlacklist).toEqual({
      companies: ['Acme'],
      headhunterPositions: ['外包'],
      excludeHeadhunters: true,
    })
  })

  it('runs with empty lists and says so when settings cannot be read', async () => {
    storage.getSettings.mockRejectedValue(new Error('storage unavailable'))
    const tracked = startRun({ label: workflow.name, source: 'manual' })
    await executeWorkflow(workflow, { source: 'manual', reuseRun: tracked })
    expect(engine.runWorkflow.mock.calls[0]?.[1].variables?.jobBlacklist).toEqual({
      companies: [],
      headhunterPositions: [],
      excludeHeadhunters: false,
    })
    const steps = getRun(tracked.runId)?.steps ?? []
    expect(steps.some((s) => s.text.includes('岗位黑名单读取失败'))).toBe(true)
  })
})
