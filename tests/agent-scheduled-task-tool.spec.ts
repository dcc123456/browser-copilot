import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  advertiseTools,
  executeTool,
  modeAutoApproves,
  runAgentTurn,
  summarizeToolResult,
} from '../src/background/agent'
import { streamCompletion } from '../src/lib/llm'
import type { AgentServerMessage } from '../src/lib/messages'
import type { ScheduledTask } from '../src/lib/scheduler-types'

/**
 * The `create_scheduled_task` tool: the agent's only write surface for the
 * scheduler. Covers the advertisement boundary (ops group, approval gating),
 * the validation contract (a malformed call must never persist a task or arm
 * an alarm), and the create/update paths including the alarm contract.
 */

// --- Shared in-memory task store, wired into both agent and scheduler --------
const store = vi.hoisted(() => {
  const tasks: unknown[] = []
  const runs: unknown[] = []
  return {
    tasks: tasks as ScheduledTask[],
    runs: runs as {
      id: string
      taskId: string
      at: number
      outcome: string
      outputs?: Record<string, unknown>
    }[],
    setTasks: (next: ScheduledTask[]): void => {
      tasks.splice(0, tasks.length, ...next)
    },
    setRuns: (next: typeof runs): void => {
      runs.splice(0, runs.length, ...next)
    },
  }
})

vi.mock('../src/lib/task-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/task-store')>()
  return {
    ...actual,
    listTasks: vi.fn(async () => [...store.tasks]),
    getTask: vi.fn(async (id: string) => store.tasks.find((task) => task.id === id)),
    // The list tool now reports what each task's latest successful run actually
    // handed on, so the run log is part of this surface too.
    listRuns: vi.fn(async () => [...store.runs]),
    saveTask: vi.fn(async (task: ScheduledTask) => {
      const index = store.tasks.findIndex((entry) => entry.id === task.id)
      if (index >= 0) store.tasks[index] = task
      else store.tasks.push(task)
    }),
  }
})

vi.mock('../src/lib/workflow/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/workflow/storage')>()
  return {
    ...actual,
    getWorkflow: vi.fn(async (id: string) =>
      id === 'wf-1' ? ({ id: 'wf-1', name: 'Collect headlines' } as unknown) : undefined,
    ),
    listWorkflows: vi.fn(async () => [{ id: 'wf-1', name: 'Collect headlines' } as unknown]),
  }
})

vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: vi.fn() }
})

const getActiveProviderMock = vi.fn()
vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return { ...actual, getActiveProvider: (...args: unknown[]) => getActiveProviderMock(...args) }
})

const alarmsByName = new Map<string, { name: string; when?: number }>()

function makeTask(partial: Partial<ScheduledTask> & Pick<ScheduledTask, 'id'>): ScheduledTask {
  return {
    name: 'Task',
    enabled: true,
    schedule: { kind: 'daily', hour: 9, minute: 0 },
    kind: 'agent-prompt',
    prompt: 'hello',
    maxToolRounds: 50,
    notifyFeishu: false,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  }
}

const baseCtx = {
  conversationId: 'test-conv',
  navigated: false,
  disabled: new Set<string>(),
}

beforeEach(() => {
  store.setTasks([])
  store.setRuns([])
  alarmsByName.clear()
  vi.stubGlobal('chrome', {
    alarms: {
      create: vi.fn(async (name: string, info?: { when?: number }) => {
        alarmsByName.set(name, { name, ...(info ? { when: info.when } : {}) })
      }),
      clear: vi.fn(async (name: string) => {
        alarmsByName.delete(name)
        return true
      }),
      getAll: vi.fn(async () => [...alarmsByName.values()]),
    },
  })
  getActiveProviderMock.mockResolvedValue({
    apiKey: 'k',
    baseUrl: 'https://x',
    model: 'm',
    label: 'test',
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('advertisement and gating', () => {
  it('rides the ops group: hidden until loaded, advertised after', () => {
    expect(advertiseTools({ mode: 'full' }).map((t) => t.function.name)).not.toContain(
      'create_scheduled_task',
    )
    const loaded = advertiseTools({ mode: 'full', loadedGroups: new Set(['ops']) }).map(
      (tool) => tool.function.name,
    )
    expect(loaded).toContain('create_scheduled_task')
  })

  it('is hidden in read-only mode: arming a recurring job is a persistent side effect', () => {
    const names = advertiseTools({ mode: 'readonly', loadedGroups: new Set(['ops']) }).map(
      (tool) => tool.function.name,
    )
    expect(names).not.toContain('create_scheduled_task')
  })

  it('asks in semi mode and runs unattended-safe in full/workflow', () => {
    expect(modeAutoApproves('semi', 'create_scheduled_task')).toBe(false)
    expect(modeAutoApproves('full', 'create_scheduled_task')).toBe(true)
    expect(modeAutoApproves('workflow', 'create_scheduled_task')).toBe(true)
  })
})

describe('create_scheduled_task execution', () => {
  it('creates a daily agent-prompt task and arms its alarm', async () => {
    const output = await executeTool(
      'create_scheduled_task',
      {
        name: 'Daily digest',
        schedule: { kind: 'daily', hour: 9 },
        prompt: 'Check the dashboard and summarize.',
      },
      baseCtx,
    )
    const parsed = JSON.parse(output) as {
      ok: boolean
      id: string
      schedule: string
      nextRunAt: string | null
      updated: boolean
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.schedule).toBe('Daily 09:00')
    expect(parsed.updated).toBe(false)
    expect(parsed.nextRunAt).toBeTruthy()

    const saved = store.tasks[0]!
    expect(saved.name).toBe('Daily digest')
    expect(saved.kind).toBe('agent-prompt')
    expect(saved.prompt).toBe('Check the dashboard and summarize.')
    expect(saved.enabled).toBe(true)
    expect(saved.schedule).toEqual({ kind: 'daily', hour: 9, minute: 0 })

    // The alarm is armed under the plain-task prefix, at least one minute out
    // (chrome.alarms rejects shorter delays).
    const alarm = alarmsByName.get(`task:${parsed.id}`)
    expect(alarm?.when).toBeGreaterThan(Date.now())
  })

  it('creates a workflow task under the workflow alarm prefix', async () => {
    const output = await executeTool(
      'create_scheduled_task',
      {
        name: 'Hourly scrape',
        schedule: { kind: 'interval', minutes: 60 },
        kind: 'workflow',
        workflowId: 'wf-1',
      },
      baseCtx,
    )
    const parsed = JSON.parse(output) as { ok: boolean; id: string; kind: string }
    expect(parsed.ok).toBe(true)
    expect(parsed.kind).toBe('workflow')
    expect(alarmsByName.has(`workflow:${parsed.id}`)).toBe(true)
    // A workflow task stays prompt-less, like the Tasks-tab editor keeps them.
    const saved = store.tasks[0]!
    expect(saved.prompt).toBeUndefined()
    expect(saved.workflowId).toBe('wf-1')
  })

  it('rejects a workflow id that does not exist, listing what is available', async () => {
    const output = await executeTool(
      'create_scheduled_task',
      {
        name: 'Broken',
        schedule: { kind: 'daily', hour: 9 },
        kind: 'workflow',
        workflowId: 'nope',
      },
      baseCtx,
    )
    const parsed = JSON.parse(output) as { ok: boolean; error: string; available?: unknown[] }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('No workflow with id "nope"')
    expect(parsed.available).toEqual([{ id: 'wf-1', name: 'Collect headlines' }])
    expect(store.tasks).toHaveLength(0)
    expect(alarmsByName.size).toBe(0)
  })

  it('refuses a duplicate name and points at the existing id', async () => {
    store.setTasks([makeTask({ id: 'existing-1', name: 'Daily digest' })])
    const output = await executeTool(
      'create_scheduled_task',
      {
        name: 'daily DIGEST',
        schedule: { kind: 'daily', hour: 8 },
        prompt: 'other',
      },
      baseCtx,
    )
    const parsed = JSON.parse(output) as { ok: boolean; existingId?: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.existingId).toBe('existing-1')
    expect(store.tasks).toHaveLength(1)
  })

  it('updates an existing task by id: same id, new schedule, alarm re-armed', async () => {
    store.setTasks([makeTask({ id: 'existing-1', name: 'Digest' })])
    const output = await executeTool(
      'create_scheduled_task',
      {
        id: 'existing-1',
        name: 'Digest',
        schedule: { kind: 'weekdays', hour: 8, minute: 30 },
        prompt: 'updated prompt',
      },
      baseCtx,
    )
    const parsed = JSON.parse(output) as { ok: boolean; updated: boolean; id: string }
    expect(parsed.ok).toBe(true)
    expect(parsed.updated).toBe(true)
    expect(parsed.id).toBe('existing-1')
    const saved = store.tasks[0]!
    expect(saved.schedule).toEqual({ kind: 'weekdays', hour: 8, minute: 30 })
    expect(saved.prompt).toBe('updated prompt')
    expect(alarmsByName.has('task:existing-1')).toBe(true)
  })

  it('disabling a task clears its alarm instead of arming it', async () => {
    const output = await executeTool(
      'create_scheduled_task',
      {
        name: 'Paused',
        schedule: { kind: 'daily', hour: 9 },
        prompt: 'x',
        enabled: false,
      },
      baseCtx,
    )
    const parsed = JSON.parse(output) as { ok: boolean; id: string }
    expect(parsed.ok).toBe(true)
    expect(alarmsByName.has(`task:${parsed.id}`)).toBe(false)
  })

  it.each([
    ['missing name', { schedule: { kind: 'daily', hour: 9 }, prompt: 'x' }, 'name'],
    ['agent-prompt without prompt', { name: 'X', schedule: { kind: 'daily', hour: 9 } }, 'prompt'],
    [
      'workflow without workflowId',
      { name: 'X', schedule: { kind: 'daily', hour: 9 }, kind: 'workflow' },
      'workflowId',
    ],
    ['missing schedule', { name: 'X', prompt: 'x' }, 'schedule'],
    [
      'unknown schedule kind',
      { name: 'X', prompt: 'x', schedule: { kind: 'hourly' } },
      'schedule.kind must be one of',
    ],
    [
      'interval without minutes',
      { name: 'X', prompt: 'x', schedule: { kind: 'interval' } },
      'positive "minutes"',
    ],
    [
      'weekly without days',
      { name: 'X', prompt: 'x', schedule: { kind: 'weekly', hour: 9 } },
      'non-empty "days"',
    ],
    [
      'weekly with out-of-range days only',
      { name: 'X', prompt: 'x', schedule: { kind: 'weekly', days: [7, 9], hour: 9 } },
      'non-empty "days"',
    ],
    [
      'daily without hour',
      { name: 'X', prompt: 'x', schedule: { kind: 'daily' } },
      'numeric "hour"',
    ],
    [
      'unknown update id',
      { id: 'ghost', name: 'X', schedule: { kind: 'daily', hour: 9 }, prompt: 'x' },
      'No scheduled task with id',
    ],
    [
      'once without a parseable instant',
      { name: 'X', prompt: 'x', schedule: { kind: 'once', at: 'tonight' } },
      'needs "at"',
    ],
    [
      'outputs on a task that cannot produce them',
      { name: 'X', prompt: 'x', schedule: { kind: 'daily', hour: 9 }, outputs: ['noteUrl'] },
      'only a workflow-kind run produces',
    ],
    [
      'an output name no token can express',
      {
        name: 'X',
        schedule: { kind: 'daily', hour: 9 },
        kind: 'workflow',
        workflowId: 'wf-1',
        outputs: ['note-url'],
      },
      'plain identifiers',
    ],
    [
      'a bulk article body passed as a handoff value',
      {
        name: 'X',
        schedule: { kind: 'daily', hour: 9 },
        kind: 'workflow',
        workflowId: 'wf-1',
        variables: { body: 'x'.repeat(5000) },
      },
      'bulk content',
    ],
    [
      'a variable that would shadow the reference layer',
      {
        name: 'X',
        schedule: { kind: 'daily', hour: 9 },
        kind: 'workflow',
        workflowId: 'wf-1',
        variables: { upstream: 'x' },
      },
      'belongs to the reference layer',
    ],
    [
      'a chain parent that does not exist',
      {
        name: 'X',
        schedule: { kind: 'daily', hour: 9 },
        kind: 'workflow',
        workflowId: 'wf-1',
        followsTaskId: 'ghost-parent',
      },
      'No scheduled task with id "ghost-parent"',
    ],
  ])('rejects %s without persisting anything', async (_label, args, errorPart) => {
    const output = await executeTool(
      'create_scheduled_task',
      args as Record<string, unknown>,
      baseCtx,
    )
    const parsed = JSON.parse(output) as { ok: boolean; error: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain(errorPart)
    expect(store.tasks).toHaveLength(0)
    expect(alarmsByName.size).toBe(0)
  })

  it('clamps out-of-range values into what alarms accept instead of erroring', async () => {
    const output = await executeTool(
      'create_scheduled_task',
      {
        name: 'Clamped',
        schedule: { kind: 'interval', minutes: 999999 },
        prompt: 'x',
      },
      baseCtx,
    )
    const parsed = JSON.parse(output) as { ok: boolean }
    expect(parsed.ok).toBe(true)
    // 999999 minutes clamps to the one-day max (1440).
    expect(store.tasks[0]!.schedule).toEqual({ kind: 'interval', minutes: 1440 })
  })

  it('summarizes for the transcript chip', async () => {
    const output = await executeTool(
      'create_scheduled_task',
      { name: 'Digest', schedule: { kind: 'daily', hour: 9 }, prompt: 'x' },
      baseCtx,
    )
    expect(summarizeToolResult('create_scheduled_task', output)).toContain(
      'Created scheduled task "Digest" (Daily 09:00)',
    )
  })

  it('list_scheduled_tasks exposes ids so the model can update later', async () => {
    store.setTasks([makeTask({ id: 'existing-1', name: 'Digest' })])
    const output = await executeTool('list_scheduled_tasks', {}, baseCtx)
    const parsed = JSON.parse(output) as { tasks: { id?: string }[] }
    expect(parsed.tasks[0]?.id).toBe('existing-1')
  })

  describe('one-shot and chained tasks', () => {
    it('creates a one-shot task and arms it at the requested instant', async () => {
      const at = new Date(2026, 10, 2, 20, 30).getTime()
      const output = await executeTool(
        'create_scheduled_task',
        {
          name: 'Publish at golden hour',
          kind: 'workflow',
          workflowId: 'wf-1',
          schedule: { kind: 'once', at },
          outputs: ['noteUrl'],
        },
        baseCtx,
      )
      const parsed = JSON.parse(output) as {
        ok: boolean
        id: string
        schedule: string
        outputs: string[]
      }
      expect(parsed.ok).toBe(true)
      // What the user reads on the approval card: a one-shot, not "Daily 09:00".
      expect(parsed.schedule).toContain('One-time')
      expect(parsed.outputs).toEqual(['noteUrl'])
      expect(store.tasks[0]?.schedule).toEqual({ kind: 'once', at })
      expect(alarmsByName.get(`workflow:${parsed.id}`)?.when).toBe(at)
    })

    it('refuses a chain parent that produces nothing to hand on', async () => {
      store.setTasks([makeTask({ id: 'prompt-parent', name: 'Prompt parent' })])
      const output = await executeTool(
        'create_scheduled_task',
        {
          name: 'Child',
          kind: 'workflow',
          workflowId: 'wf-1',
          schedule: { kind: 'interval', minutes: 30 },
          followsTaskId: 'prompt-parent',
        },
        baseCtx,
      )
      const parsed = JSON.parse(output) as { ok: boolean; error: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain('must be a workflow-kind task')
      expect(store.tasks).toHaveLength(1)
    })

    it('links a child to a workflow parent and inherits its chain id', async () => {
      const parentOut = await executeTool(
        'create_scheduled_task',
        {
          name: 'Publish',
          kind: 'workflow',
          workflowId: 'wf-1',
          schedule: { kind: 'once', at: Date.now() + 3_600_000 },
          outputs: ['noteUrl'],
        },
        baseCtx,
      )
      const parent = JSON.parse(parentOut) as { id: string }

      const childOut = await executeTool(
        'create_scheduled_task',
        {
          name: 'Comment',
          kind: 'workflow',
          workflowId: 'wf-1',
          schedule: { kind: 'interval', minutes: 30 },
          followsTaskId: parent.id,
          variables: { note: '{{upstream.noteUrl}}' },
        },
        baseCtx,
      )
      const child = JSON.parse(childOut) as { ok: boolean; follows: string; chainId: string }
      expect(child.ok).toBe(true)
      expect(child.follows).toBe('Publish')

      const stored = store.tasks.find((task) => task.name === 'Comment')
      expect(stored?.followsTaskId).toBe(parent.id)
      // The head of the chain names it, so the model never has to invent the id
      // twice in a row for the two calls to group together.
      expect(stored?.chainId).toBe(parent.id)
      expect(stored?.variables).toEqual({ note: '{{upstream.noteUrl}}' })
    })

    it('refuses to close a loop through an existing task', async () => {
      store.setTasks([
        makeTask({ id: 'a', name: 'A', kind: 'workflow', workflowId: 'wf-1' }),
        makeTask({ id: 'b', name: 'B', kind: 'workflow', workflowId: 'wf-1', followsTaskId: 'a' }),
      ])

      // B is already A's child: making A follow B would be a cycle.
      const output = await executeTool(
        'create_scheduled_task',
        {
          id: 'a',
          name: 'A',
          kind: 'workflow',
          workflowId: 'wf-1',
          schedule: { kind: 'daily', hour: 9 },
          followsTaskId: 'b',
        },
        baseCtx,
      )
      const parsed = JSON.parse(output) as { ok: boolean; error: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain('loop')

      const self = await executeTool(
        'create_scheduled_task',
        {
          id: 'a',
          name: 'A',
          kind: 'workflow',
          workflowId: 'wf-1',
          schedule: { kind: 'daily', hour: 9 },
          followsTaskId: 'a',
        },
        baseCtx,
      )
      expect(JSON.parse(self).ok).toBe(false)
    })

    it('lists a fired (disabled) one-shot parent with the keys it handed on', async () => {
      // The exact state after a golden-hour publish: the task switched itself off.
      store.setTasks([
        makeTask({
          id: 'parent',
          name: 'Publish',
          kind: 'workflow',
          workflowId: 'wf-1',
          enabled: false,
          schedule: { kind: 'once', at: Date.now() - 60_000 },
          outputs: ['noteUrl'],
        }),
      ])
      store.setRuns([
        { id: 'r2', taskId: 'parent', at: 20, outcome: 'failed', outputs: { error: 'x' } },
        { id: 'r1', taskId: 'parent', at: 10, outcome: 'ok', outputs: { noteUrl: 'https://x/1' } },
      ])

      const output = await executeTool('list_scheduled_tasks', {}, baseCtx)
      const parsed = JSON.parse(output) as {
        tasks: {
          id: string
          enabled: boolean
          outputs?: string[]
          lastOutputKeys?: string[]
        }[]
      }
      const listed = parsed.tasks.find((task) => task.id === 'parent')
      // Hiding it would make the chain unreferenceable precisely when its value
      // becomes available.
      expect(listed?.enabled).toBe(false)
      expect(listed?.outputs).toEqual(['noteUrl'])
      expect(listed?.lastOutputKeys).toEqual(['noteUrl'])
    })
  })
})

describe('workflow turns mount the workflow-generator skill', () => {
  const streamMock = vi.mocked(streamCompletion)

  afterEach(() => {
    streamMock.mockReset()
  })

  function deps(mode: 'full' | 'workflow') {
    return {
      send: (_message: AgentServerMessage): void => {},
      confirm: vi.fn(async () => true),
      conversationId: `conv-${Math.random().toString(36).slice(2)}`,
      getMode: async () => mode,
      getMaxToolRounds: async () => 3,
      getToolConfig: async () => ({ disabledTools: [], basePrompt: '' }),
    }
  }

  function systemMessage(index: number): string {
    const request = streamMock.mock.calls[index]?.[0]
    if (!request) throw new Error(`no request at index ${index}`)
    return (request.messages[0] as { content: string }).content
  }

  it('mounts the built-in operator guide into the system prompt in workflow mode', async () => {
    streamMock.mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)
    await runAgentTurn(
      [{ role: 'user', content: 'build a workflow' }] as never,
      deps('workflow') as never,
    )

    const system = systemMessage(0)
    expect(system).toContain('MODE SKILL — workflow-generator (ACTIVE)')
    // Content from the guide body, not just the header.
    expect(system).toContain('对话动作 → 算子映射')
    expect(system).toContain('数据必须是动态的')
    // The guide's own scheduling pointer (links to the create_scheduled_task tool).
    expect(system).toContain('create_scheduled_task')
  })

  it('does not mount the skill in other modes', async () => {
    streamMock.mockResolvedValueOnce({ content: 'done', toolCalls: [] } as never)
    await runAgentTurn([{ role: 'user', content: 'hello' }] as never, deps('full') as never)
    expect(systemMessage(0)).not.toContain('MODE SKILL')
  })
})
