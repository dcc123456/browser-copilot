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

import {
  addRun,
  disableTask,
  listRuns,
  listTasks,
  recordFinishedRun,
  saveTask,
} from '../src/lib/task-store'
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

/**
 * `asTask` rebuilds every stored record from a whitelist of fields, so a chain
 * field added to the type but not to the rebuilder is invisible until the worker
 * restarts — the feature appears to work and then evaporates.
 */
describe('chained task fields survive the store round trip', () => {
  it('persists the one-shot schedule and every chain field', async () => {
    const at = Date.now() + 3_600_000
    await saveTask({
      ...task('chain-child'),
      schedule: { kind: 'once', at },
      kind: 'workflow',
      workflowId: 'wf-publish',
      followsTaskId: 'chain-parent',
      chainId: 'chain-parent',
      variables: { note: '{{upstream.noteUrl}}', count: 2, tags: ['a', 'b'] },
      outputs: ['noteUrl'],
    })

    const [loaded] = (await listTasks()).filter((entry) => entry.id === 'chain-child')
    expect(loaded?.schedule).toEqual({ kind: 'once', at })
    expect(loaded?.followsTaskId).toBe('chain-parent')
    expect(loaded?.chainId).toBe('chain-parent')
    expect(loaded?.variables).toEqual({ note: '{{upstream.noteUrl}}', count: 2, tags: ['a', 'b'] })
    expect(loaded?.outputs).toEqual(['noteUrl'])
  })

  it('repairs a broken one-shot instant into manual rather than into a daily publish', async () => {
    await saveTask({ ...task('broken-once'), schedule: { kind: 'once', at: 'soon' } as never })
    const [loaded] = (await listTasks()).filter((entry) => entry.id === 'broken-once')
    expect(loaded?.schedule).toEqual({ kind: 'none' })
  })

  it('drops names the reference layer owns and values that are not handoff-sized', async () => {
    await saveTask({
      ...task('dirty-bag'),
      variables: {
        upstream: 'shadow',
        refData: 'shadow',
        nested: { a: 1 },
        keep: 'ok',
      } as never,
      outputs: ['noteUrl', '1bad', 'ok_name'],
    })
    const [loaded] = (await listTasks()).filter((entry) => entry.id === 'dirty-bag')
    expect(loaded?.variables).toEqual({ keep: 'ok' })
    expect(loaded?.outputs).toEqual(['noteUrl', 'ok_name'])
  })

  it('still reads a record written before the chain fields existed', async () => {
    await saveTask(task('legacy-task'))
    const [loaded] = (await listTasks()).filter((entry) => entry.id === 'legacy-task')
    expect(loaded?.followsTaskId).toBeUndefined()
    expect(loaded?.outputs).toBeUndefined()
    expect(loaded?.variables).toBeUndefined()
  })

  it('disables a fired one-shot without dropping a task saved at the same moment', async () => {
    // The one-shot lifecycle writes through this locked op, not a bare saveTask:
    // racing an unlocked read-modify-write is how the run log used to lose rows.
    await saveTask(task('parent'))
    await Promise.all([disableTask('parent'), saveTask(task('sibling'))])

    const tasks = await listTasks()
    expect(tasks.map((entry) => entry.id)).toContain('sibling')
    expect(tasks.find((entry) => entry.id === 'parent')?.enabled).toBe(false)
  })
})
