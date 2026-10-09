import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../src/lib/scheduler-types'
import {
  onAlarm,
  rescheduleAll,
  scheduleTask,
  taskIdFromAlarmName,
} from '../src/background/scheduler'
import { runTask } from '../src/background/task-runner'

/**
 * Shared mutable task store, seeded via `setTasks`. Exposed through
 * `vi.hoisted` so the `vi.mock` factory below can read it before the test body
 * runs. The task-runner is stubbed so importing the scheduler does not pull in
 * the agent/github/feishu machinery.
 */
const store = vi.hoisted(() => {
  const tasks: unknown[] = []
  return {
    tasks: tasks as any[],
    setTasks: (next: unknown[]) => {
      tasks.splice(0, tasks.length, ...next)
    },
  }
})

vi.mock('../src/background/task-runner', () => ({
  runTask: vi.fn(async () => ({ ok: true, skipped: false, summary: '' })),
}))

vi.mock('../src/lib/task-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/task-store')>()
  return {
    ...actual,
    getTask: vi.fn(async (id: string) => store.tasks.find((t) => t.id === id)),
    listTasks: vi.fn(async () => [...store.tasks]),
    // The one-shot lifecycle writes through this locked op, not `saveTask`:
    // flipping the shared record is exactly what the test must observe.
    disableTask: vi.fn(async (id: string) => {
      const task = store.tasks.find((t) => t.id === id)
      if (task) task.enabled = false
    }),
  }
})

// A separate alarm double keeps the real implementations readable.
const alarmsByName = new Map<string, { name: string; when?: number }>()
const createdCalls: string[] = []
const clearedCalls: string[] = []

function makeTask(partial: Partial<ScheduledTask> & Pick<ScheduledTask, 'id'>): ScheduledTask {
  return {
    name: 'Task',
    enabled: true,
    schedule: { kind: 'interval', minutes: 60 },
    kind: 'agent-prompt',
    prompt: 'hello',
    maxToolRounds: 25,
    notifyFeishu: false,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  }
}

describe('workflow scheduler alarm prefixes', () => {
  beforeEach(() => {
    createdCalls.length = 0
    clearedCalls.length = 0
    alarmsByName.clear()
    vi.stubGlobal('chrome', {
      alarms: {
        create: vi.fn(async (name: string, info?: { when?: number }) => {
          alarmsByName.set(name, { name, ...(info ? { when: info.when } : {}) })
          createdCalls.push(name)
        }),
        clear: vi.fn(async (name: string) => {
          alarmsByName.delete(name)
          clearedCalls.push(name)
          return true
        }),
        getAll: vi.fn(async () => [...alarmsByName.values()]),
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('parses both task: and workflow: alarm prefixes', () => {
    expect(taskIdFromAlarmName('workflow:abc')).toBe('abc')
    expect(taskIdFromAlarmName('task:def')).toBe('def')
    expect(taskIdFromAlarmName('other:ghi')).toBeNull()
  })

  it('schedules a workflow-kind task under the workflow: prefix', async () => {
    store.setTasks([makeTask({ id: 'wf-task', kind: 'workflow', workflowId: 'wf-1' })])

    await scheduleTask('wf-task')

    expect(createdCalls).toEqual(['workflow:wf-task'])
    expect(clearedCalls).toEqual([])
  })

  it('still schedules plain tasks under the task: prefix', async () => {
    store.setTasks([makeTask({ id: 'plain' })])

    await scheduleTask('plain')

    expect(createdCalls).toEqual(['task:plain'])
  })

  it('rescheduleAll clears orphaned workflow alarms and arms known ones', async () => {
    store.setTasks([makeTask({ id: 'wf-task', kind: 'workflow', workflowId: 'wf-1' })])
    // A stale alarm from a now-deleted workflow task, and one from a plain task.
    alarmsByName.set('workflow:gone', { name: 'workflow:gone' })
    alarmsByName.set('task:gone', { name: 'task:gone' })

    await rescheduleAll()

    expect(clearedCalls).toEqual(expect.arrayContaining(['workflow:gone', 'task:gone']))
    expect(alarmsByName.has('workflow:gone')).toBe(false)
    expect(alarmsByName.has('task:gone')).toBe(false)
    expect(createdCalls).toContain('workflow:wf-task')
  })

  describe('one-shot tasks', () => {
    // The module mock is created once per file, so call counts accumulate
    // across tests unless cleared here.
    beforeEach(() => {
      vi.mocked(runTask).mockClear()
    })

    it('arms the alarm at the requested instant', async () => {
      const at = Date.now() + 30 * 60_000
      store.setTasks([makeTask({ id: 'once', schedule: { kind: 'once', at } })])

      await scheduleTask('once')

      expect(createdCalls).toEqual(['task:once'])
      expect(alarmsByName.get('task:once')?.when).toBe(at)
    })

    it('clamps an imminent instant up to the alarm floor instead of dropping it', async () => {
      const before = Date.now()
      store.setTasks([makeTask({ id: 'near', schedule: { kind: 'once', at: before + 10_000 } })])

      await scheduleTask('near')

      expect(alarmsByName.get('task:near')?.when).toBeGreaterThanOrEqual(before + 60_000)
    })

    it('clears rather than re-arms a one-shot whose instant is gone', async () => {
      store.setTasks([makeTask({ id: 'gone', schedule: { kind: 'once', at: Date.now() - 1_000 } })])
      alarmsByName.set('task:gone', { name: 'task:gone' })

      await scheduleTask('gone')

      expect(clearedCalls).toContain('task:gone')
      expect(createdCalls).toEqual([])
    })

    it('fires once, switches itself off, and stays off through a reconcile', async () => {
      store.setTasks([
        makeTask({ id: 'shot', schedule: { kind: 'once', at: Date.now() + 30 * 60_000 } }),
      ])
      await scheduleTask('shot')
      createdCalls.length = 0
      clearedCalls.length = 0

      onAlarm({ name: 'task:shot' } as Parameters<typeof onAlarm>[0])
      await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(1))

      expect(store.tasks.find((task) => task.id === 'shot')?.enabled).toBe(false)
      // Disarmed BEFORE the run, so neither a throwing run nor a worker evicted
      // mid-run can leave a second firing behind.
      expect(clearedCalls).toEqual(['task:shot'])
      expect(createdCalls).toEqual([])

      await rescheduleAll()
      expect(createdCalls).not.toContain('task:shot')
      expect(alarmsByName.has('task:shot')).toBe(false)
    })

    it('keeps re-arming a recurring task before it runs', async () => {
      store.setTasks([makeTask({ id: 'daily', schedule: { kind: 'daily', hour: 9, minute: 0 } })])
      let rearmedBeforeRun = false
      vi.mocked(runTask).mockImplementation(async () => {
        rearmedBeforeRun = createdCalls.includes('task:daily')
        return { ok: true, skipped: false, summary: '' }
      })

      onAlarm({ name: 'task:daily' } as Parameters<typeof onAlarm>[0])
      await vi.waitFor(() => expect(runTask).toHaveBeenCalled())

      expect(rearmedBeforeRun).toBe(true)
      vi.mocked(runTask).mockImplementation(async () => ({
        ok: true,
        skipped: false,
        summary: '',
      }))
    })
  })
})
