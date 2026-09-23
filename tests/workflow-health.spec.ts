import { describe, expect, it } from 'vitest'
import {
  HEALTH_WINDOW,
  summarizeWorkflowHealth,
} from '../src/lib/workflow/workflow-health'
import type { TaskRunLog } from '../src/lib/scheduler-types'

function run(partial: Partial<TaskRunLog> & { at: number; ok: boolean }): TaskRunLog {
  return {
    id: `run-${partial.at}`,
    trigger: 'manual',
    skipped: false,
    summary: '',
    ...partial,
  }
}

describe('workflow health summary', () => {
  it('is no-data when the workflow has no runs', () => {
    const health = summarizeWorkflowHealth([], 'wf1')
    expect(health.status).toBe('no-data')
    expect(health.totalRuns).toBe(0)
  })

  it('only counts runs of the given workflow', () => {
    const health = summarizeWorkflowHealth(
      [
        run({ at: 1, ok: true, workflowId: 'other' }),
        run({ at: 2, ok: false, workflowId: 'wf1' }),
      ],
      'wf1',
    )
    expect(health.totalRuns).toBe(1)
    expect(health.passedRuns).toBe(0)
    expect(health.status).toBe('needs-attention')
  })

  it('is stable when every counted run passed', () => {
    const health = summarizeWorkflowHealth(
      [
        run({ at: 1, ok: true, workflowId: 'wf1' }),
        run({ at: 2, ok: true, workflowId: 'wf1' }),
      ],
      'wf1',
    )
    expect(health.status).toBe('stable')
    expect(health.passedRuns).toBe(2)
    expect(health.totalRuns).toBe(2)
  })

  it('excludes intentionally skipped runs from the ratio', () => {
    const health = summarizeWorkflowHealth(
      [
        run({ at: 1, ok: false, skipped: true, workflowId: 'wf1' }),
        run({ at: 2, ok: true, workflowId: 'wf1' }),
      ],
      'wf1',
    )
    expect(health.totalRuns).toBe(1)
    expect(health.passedRuns).toBe(1)
    expect(health.status).toBe('stable')
  })

  it('uses the most recent window of runs', () => {
    const runs = Array.from({ length: HEALTH_WINDOW + 2 }, (_, i) =>
      run({
        at: i + 1,
        ok: i >= 2, // two oldest failed, rest pass
        workflowId: 'wf1',
      }),
    )
    const health = summarizeWorkflowHealth(runs, 'wf1')
    expect(health.totalRuns).toBe(HEALTH_WINDOW)
    // The two failures fell outside the window.
    expect(health.status).toBe('stable')
  })

  it('reports the newest passed run as last verified', () => {
    const health = summarizeWorkflowHealth(
      [
        run({ at: 1, ok: true, finishedAt: 100, workflowId: 'wf1' }),
        run({ at: 2, ok: true, finishedAt: 200, workflowId: 'wf1' }),
      ],
      'wf1',
    )
    expect(health.lastVerifiedAt).toBe(200)
  })

  it('reports the category of the most recent failure', () => {
    const health = summarizeWorkflowHealth(
      [
        run({ at: 1, ok: false, failureCategory: 'LOCATOR', workflowId: 'wf1' }),
        run({ at: 2, ok: true, workflowId: 'wf1' }),
      ],
      'wf1',
    )
    expect(health.status).toBe('needs-attention')
    expect(health.lastFailureCategory).toBe('LOCATOR')
  })

  it('counts repaired and resumed runs', () => {
    const health = summarizeWorkflowHealth(
      [
        run({ at: 1, ok: true, repaired: true, workflowId: 'wf1' }),
        run({ at: 2, ok: true, resumed: true, workflowId: 'wf1' }),
      ],
      'wf1',
    )
    expect(health.repairedRuns).toBe(1)
    expect(health.resumedRuns).toBe(1)
  })
})
