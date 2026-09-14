import { beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * In-memory `chrome.storage.local` with realistic async latency. The latency is
 * the point: every mutation in `task-store` is a read-modify-write over a whole
 * array, so without serialization two concurrent writers read the same base and
 * the later write silently drops the other's entry.
 */
const disk: Record<string, unknown> = {}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeAll(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string | string[] | null) => {
          await delay(5)
          if (keys === null) return { ...disk }
          const wanted = typeof keys === 'string' ? [keys] : keys
          const out: Record<string, unknown> = {}
          for (const key of wanted) if (key in disk) out[key] = disk[key]
          return out
        },
        set: async (items: Record<string, unknown>) => {
          await delay(5)
          Object.assign(disk, items)
        },
        remove: async (keys: string | string[]) => {
          const wanted = typeof keys === 'string' ? [keys] : keys
          for (const key of wanted) delete disk[key]
        },
      },
    },
  })
})

import { addRun, listRuns, listTasks, recordFinishedRun, saveTask } from '../src/lib/task-store'
import type { ScheduledTask } from '../src/lib/scheduler-types'

function task(id: string): ScheduledTask {
  return {
    id,
    name: id,
    enabled: true,
    schedule: { kind: 'daily', hour: 10, minute: 0 },
    kind: 'agent-prompt',
    prompt: 'hi',
    maxToolRounds: 50,
    notifyFeishu: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

/**
 * Regression: a workflow-kind task used to persist TWO runs back-to-back (the
 * task wrapper and the workflow engine's own run). The unsynchronized
 * read-modify-write dropped one of them, so the surviving run-log card could be
 * the empty wrapper — a task that looked like it never started.
 */
describe('run log persistence', () => {
  it('keeps both records when two runs settle at the same moment', async () => {
    await Promise.all([
      recordFinishedRun({
        runId: 'run-a',
        taskId: 't1',
        source: 'schedule',
        outcome: 'ok',
        summary: 'wrapper',
        steps: [{ at: 1, kind: 'info', text: 'Starting workflow task…' }],
      }),
      recordFinishedRun({
        runId: 'run-b',
        taskId: 't1',
        source: 'schedule',
        outcome: 'ok',
        summary: 'engine',
        steps: [{ at: 2, kind: 'status', text: '已点击签到' }],
      }),
    ])

    const ids = (await listRuns()).map((run) => run.id)
    expect(ids).toContain('run-a')
    expect(ids).toContain('run-b')
  })

  it('keeps both records when two ad-hoc runs are appended at the same moment', async () => {
    await Promise.all([
      addRun({ trigger: 'manual', ok: true, skipped: false, summary: 'one' }),
      addRun({ trigger: 'manual', ok: true, skipped: false, summary: 'two' }),
    ])
    const summaries = (await listRuns()).map((run) => run.summary)
    expect(summaries).toContain('one')
    expect(summaries).toContain('two')
  })

  it('keeps both tasks when two saves race', async () => {
    await Promise.all([saveTask(task('task-a')), saveTask(task('task-b'))])
    const ids = (await listTasks()).map((entry) => entry.id)
    expect(ids).toContain('task-a')
    expect(ids).toContain('task-b')
  })
})
