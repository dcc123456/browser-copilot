import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../src/lib/scheduler-types'
import {
  rescheduleAll,
  scheduleTask,
  taskIdFromAlarmName,
} from '../src/background/scheduler'

/**
 * Shared mutable task store, seeded via `setTasks`. Exposed through
 * `vi.hoisted` so the `vi.mock` factory below can read it before the test body
 * runs. The task-runner is stubbed so importing the scheduler does not pull in
 * the agent/github/feishu machinery.
 */
const store = vi.hoisted(() => {
  const tasks: unknown[] = []
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
})