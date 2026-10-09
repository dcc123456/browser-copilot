import { describe, expect, it } from 'vitest'
import { verifyWorkflowGoal } from '../src/background/workflow-engine/goal-verification'
import type { ConditionPageProbe } from '../src/background/workflow-engine/condition-runtime'
import type { ExecuteWorkflowResult } from '../src/background/workflow-engine/run-workflow'
import type { Workflow } from '../src/lib/workflow/types'

/**
 * Round 33 was the first replay that ran all 17 steps, proved the effect and
 * saved a real 小红书 draft — and it still refused its own certificate, on
 * `元素存在 "草稿箱" — 元素不存在`. The drawer renders AFTER the save click
 * returns, and L3 read the page exactly once, in the instant the last step came
 * back. About a minute later the same element was found present AND visible on
 * the same tab. These tests pin the settle window that closes that gap: the rows
 * that failed get re-read inside a bounded window, the rows that held do not, and
 * a row that never holds still bars certification.
 */
const drawerRow = {
  kind: 'elementExists' as const,
  target: { selector: '.d-drawer .draft-box-title' },
}
const titleRow = { kind: 'variableExists' as const, name: 'noteTitle' }

const workflowOf = (successConditions: unknown[]): Workflow =>
  ({
    id: 'wf-settle',
    name: 'settle window',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    trigger: { type: 'manual', enabled: true },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
      goalSpec: { summary: '草稿箱 已列出新草稿', successConditions },
    },
    drawflow: {
      nodes: [
        {
          id: 'n1',
          label: 'event-click',
          position: { x: 0, y: 0 },
          data: { blockId: 'event-click' },
        },
      ],
      edges: [],
    },
  }) as unknown as Workflow

const run: ExecuteWorkflowResult = {
  runId: 'r1',
  outcome: 'ok',
  completedNodeIds: ['n1'],
  variables: { noteTitle: '这个开源AI插件会替你点网页' },
}

/** `exists` answers false for the first `absentReads` reads, then true forever. */
const probeOf = (absentReads: number): { probe: ConditionPageProbe; existsCalls: () => number } => {
  let reads = 0
  return {
    existsCalls: () => reads,
    probe: {
      exists: async () => {
        reads += 1
        return reads > absentReads
      },
      visible: async () => true,
      enabled: async () => true,
      text: async () => '草稿箱',
      attribute: async () => '',
      count: async () => 1,
      url: async () => 'https://creator.xiaohongshu.com/publish/publish?target=image',
    },
  }
}

const sleeps: () => { delays: number[]; sleep: (ms: number) => Promise<void> } = () => {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms)
    },
  }
}

describe('L3 re-reads an unsettled page instead of calling it a failed goal', () => {
  it('a row that fails on read 1 and holds on read 2 certifies, and says it waited', async () => {
    const { probe } = probeOf(1)
    const { delays, sleep } = sleeps()
    const report = await verifyWorkflowGoal(workflowOf([titleRow, drawerRow]), run, probe, {
      settleMs: 3000,
      pollMs: 1000,
      sleep,
    })
    expect(report.l3.conditions.map((c) => c.satisfied)).toEqual([true, true])
    expect(report.l3.allHeld).toBe(true)
    expect(report.certified).toBe(true)
    expect(report.settledAfterMs).toBe(1000)
    expect(delays).toEqual([1000])
  })

  it('the row order and its prose survive the re-read', async () => {
    const { probe } = probeOf(1)
    const { sleep } = sleeps()
    const report = await verifyWorkflowGoal(workflowOf([drawerRow, titleRow]), run, probe, {
      settleMs: 3000,
      pollMs: 1000,
      sleep,
    })
    expect(report.l3.conditions.map((c) => c.description)).toEqual([
      expect.stringContaining('.draft-box-title'),
      expect.stringContaining('noteTitle'),
    ])
    expect(report.certified).toBe(true)
  })

  it('a row that never appears still bars certification once the window is spent', async () => {
    const { probe, existsCalls } = probeOf(999)
    const { delays, sleep } = sleeps()
    const report = await verifyWorkflowGoal(workflowOf([titleRow, drawerRow]), run, probe, {
      settleMs: 3000,
      pollMs: 1000,
      sleep,
    })
    expect(report.l3.allHeld).toBe(false)
    expect(report.certified).toBe(false)
    expect(report.settledAfterMs).toBeUndefined()
    expect(delays).toEqual([1000, 1000, 1000])
    expect(existsCalls()).toBe(4)
    expect(report.reason).toContain('re-read for 3000 ms')
  })

  it('only the failed rows are re-asked — a row that already held is not re-tried', async () => {
    const steady = { kind: 'elementVisible' as const, target: { selector: '.publish-form' } }
    let visibleReads = 0
    const { probe, existsCalls } = probeOf(1)
    const countingProbe: ConditionPageProbe = {
      ...probe,
      visible: async () => {
        visibleReads += 1
        return true
      },
    }
    const { sleep } = sleeps()
    const report = await verifyWorkflowGoal(workflowOf([steady, drawerRow]), run, countingProbe, {
      settleMs: 3000,
      pollMs: 1000,
      sleep,
    })
    expect(report.certified).toBe(true)
    expect(visibleReads).toBe(1)
    expect(existsCalls()).toBe(2)
  })

  it('a clean run pays nothing: no sleep, no second read', async () => {
    const { probe, existsCalls } = probeOf(0)
    const { delays, sleep } = sleeps()
    const report = await verifyWorkflowGoal(workflowOf([titleRow, drawerRow]), run, probe, {
      settleMs: 3000,
      pollMs: 1000,
      sleep,
    })
    expect(report.certified).toBe(true)
    expect(report.settledAfterMs).toBeUndefined()
    expect(delays).toEqual([])
    expect(existsCalls()).toBe(1)
  })

  it('without a window the verdict is the single honest read (and nothing waits)', async () => {
    const { probe, existsCalls } = probeOf(1)
    const report = await verifyWorkflowGoal(workflowOf([drawerRow]), run, probe)
    expect(report.certified).toBe(false)
    expect(existsCalls()).toBe(1)
    expect(report.reason).toBe('L3 failed: the workflow goal success conditions did not all hold.')
  })

  it('a partial last slice never overshoots the window', async () => {
    const { probe, existsCalls } = probeOf(2)
    const { delays, sleep } = sleeps()
    const report = await verifyWorkflowGoal(workflowOf([drawerRow]), run, probe, {
      settleMs: 1500,
      pollMs: 1000,
      sleep,
    })
    expect(delays).toEqual([1000, 500])
    expect(existsCalls()).toBe(3)
    expect(report.certified).toBe(true)
    expect(report.settledAfterMs).toBe(1500)
  })
})
