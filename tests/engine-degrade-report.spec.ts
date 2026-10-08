/**
 * A degraded step must be VISIBLE in the run result.
 *
 * The self-heal write-back in `lib/workflow/self-heal` only gets to work if the
 * engine hands the caller what the page reported: which node ran on a weaker
 * locator, which candidate won, and how many elements were in play. These tests
 * pin that channel end to end — the collector, the run-log line the user sees,
 * and the rule that a clean run reports nothing.
 */
import { describe, expect, it } from 'vitest'
import type { DegradeEvidence } from '../src/lib/ops'
import { runWorkflow } from '../src/background/workflow-engine/engine'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

function makeWorkflow(nodes: WorkflowNode[]): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes, edges: [] },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
    },
  }
}

const node = (id: string, label = 'event-click'): WorkflowNode => ({
  id,
  label,
  position: { x: 0, y: 0 },
  data: { blockId: label, selector: '.stale' },
})

const evidence: DegradeEvidence = {
  rung: 3,
  from: 'css|.stale',
  to: 'css|#buy',
  matchCount: 4,
  candidates: [
    { strategy: 'css|.stale', score: 20 },
    { strategy: 'css|#buy', score: 35 },
  ],
}

describe('engine degradation reporting', () => {
  it('collects what the kernel reported about a node that had to degrade', async () => {
    const result = await runWorkflow(makeWorkflow([node('a')]), {
      executors: {
        'event-click': async (_data, ctx) => {
          ctx.lastResolution = {
            usedSpec: evidence.to,
            usedFallback: true,
            matched: evidence.matchCount,
            degrade: evidence,
          }
          return null
        },
      },
    })

    expect(result.outcome).toBe('ok')
    expect(result.degradations).toEqual([
      { nodeId: 'a', rung: 3, from: 'css|.stale', to: 'css|#buy', matchCount: 4 },
    ])
    // The user reads this in the run log: a step that degraded is not a step
    // that resolved, and the difference must not be invisible.
    expect(result.steps?.some((line) => line.text.includes('定位降级（第 3 级）'))).toBe(true)
  })

  it('reports nothing for a clean resolution, and nothing for a run that never got there', async () => {
    const clean = await runWorkflow(makeWorkflow([node('a')]), {
      executors: {
        'event-click': async (_data, ctx) => {
          ctx.lastResolution = { usedSpec: 'css|.stale', usedFallback: false, matched: 1 }
          return null
        },
      },
    })
    expect(clean.degradations).toEqual([])

    const failed = await runWorkflow(makeWorkflow([node('a')]), {
      executors: {
        'event-click': async (_data, ctx) => {
          // The kernel degraded and THEN the step failed — the write-back must
          // not bank a candidate that never actually worked.
          ctx.lastResolution = {
            usedSpec: evidence.to,
            usedFallback: true,
            matched: evidence.matchCount,
            degrade: evidence,
          }
          throw new Error('LOCATOR_NOT_FOUND')
        },
      },
    })
    expect(failed.outcome).toBe('failed')
    expect(failed.degradations).toEqual([])
  })

  it('keeps one report per node even across retries', async () => {
    let attempts = 0
    const retrying: WorkflowNode = {
      id: 'a',
      label: 'event-click',
      position: { x: 0, y: 0 },
      data: {
        blockId: 'event-click',
        selector: '.stale',
        onError: { enable: true, toDo: 'retry', retryTimes: 1, retryInterval: 0 },
      },
    }
    const result = await runWorkflow(makeWorkflow([retrying]), {
      executors: {
        'event-click': async (_data, ctx) => {
          attempts += 1
          if (attempts === 1) throw new Error('transient')
          ctx.lastResolution = {
            usedSpec: evidence.to,
            usedFallback: true,
            matched: evidence.matchCount,
            degrade: evidence,
          }
          return null
        },
      },
    })
    expect(result.outcome).toBe('ok')
    expect(result.degradations).toHaveLength(1)
  })
})
