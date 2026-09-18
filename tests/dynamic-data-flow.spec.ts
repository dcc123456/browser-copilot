/**
 * End-to-end coverage for "no dead data": a business value observed while
 * driving the live page must be RECORDED as a reference, and that reference
 * must actually resolve when the workflow replays.
 *
 * The two halves are tested against the real code on both sides — the real
 * operator bridge for recording, the real `executeWorkflow` for the run's
 * starting scope — because the failure this guards against is precisely the two
 * halves disagreeing: a graph full of `{{keyword}}` and a run that seeds
 * nothing, which is worse than the frozen literal it replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({ runWorkflow: vi.fn() }))
vi.mock('../src/background/workflow-engine/engine', () => ({
  runWorkflow: engine.runWorkflow,
}))

/**
 * The driver chain is real except the page-touching entry points: nothing in
 * this suite may reach a browser.
 */
vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return {
    ...actual,
    execOnActiveTab: vi.fn(async () => ({
      ok: true,
      found: true,
      frameUrl: 'https://example.com/',
      isTopFrame: true,
    })),
    elementExists: vi.fn(async () => 1),
    countElements: vi.fn(async () => 0),
    execJsOnActiveTab: vi.fn(async () => ({ ok: true, data: undefined })),
  }
})
vi.mock('../src/background/automation-scope', () => ({
  normalScopeFromWindowId: vi.fn(async () => undefined),
}))

function makeChromeMock() {
  const store = new Map<string, unknown>()
  return {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const wanted = typeof keys === 'string' ? [keys] : keys
          const out: Record<string, unknown> = {}
          for (const key of wanted) if (store.has(key)) out[key] = store.get(key)
          return out
        },
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value)
        },
        remove: async () => {},
      },
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('chrome', makeChromeMock())
  engine.runWorkflow.mockReset()
})

import { getDraftSnapshot, actionNodesOf } from '../src/background/operator-tool-handler'
import { runOperatorToolWithExecution } from '../src/background/operator-tool-run'
import { executeWorkflow } from '../src/background/workflow-engine/run-workflow'
import {
  EXECUTORS,
  type BlockExecutor,
  type WorkflowExecCtx,
} from '../src/background/workflow-engine/executors'
import type { Workflow, WorkflowNode } from '../src/lib/workflow/types'

const signal = new AbortController().signal

/** Stub executors that record what they were handed. */
function okExecutors(overrides: Record<string, BlockExecutor> = {}) {
  const calls: { blockId: string; data: Record<string, unknown> }[] = []
  const executors: Record<string, BlockExecutor> = {}
  const record =
    (blockId: string): BlockExecutor =>
    async (data) => {
      calls.push({ blockId, data })
      return null
    }
  for (const id of ['forms', 'event-click', 'set-variable', 'get-text', 'new-tab']) {
    executors[id] = record(id)
  }
  return { calls, executors: { ...executors, ...overrides } }
}

function run(
  conversationId: string,
  name: string,
  args: Record<string, unknown>,
  executors: Record<string, BlockExecutor>,
) {
  return runOperatorToolWithExecution({ name, args, conversationId, signal, executors })
}

/** The trigger node of a recorded draft. */
function triggerNodeOf(conversationId: string): WorkflowNode | undefined {
  return getDraftSnapshot(conversationId)?.nodes.find((n) => n.label === 'trigger')
}

/** The single action node of a recorded draft. */
function actionNodeOf(conversationId: string): WorkflowNode | undefined {
  const draft = getDraftSnapshot(conversationId)
  return draft ? actionNodesOf(draft)[0] : undefined
}

/** The recorded node for one block id (a draft can hold several). */
function nodeFor(conversationId: string, blockId: string): WorkflowNode | undefined {
  const draft = getDraftSnapshot(conversationId)
  return draft ? actionNodesOf(draft).find((n) => n.data['blockId'] === blockId) : undefined
}

describe('generation records references, not frozen literals', () => {
  it('turns a typed value into a declared input and still drives the page', async () => {
    const { calls, executors } = okExecutors()
    const out = await run(
      'g1',
      'wf_op_forms',
      { selector: '#q', type: 'text-field', value: 'iPhone' },
      executors,
    )

    expect(out.ok).toBe(true)
    if (!out.ok) return

    // The page was really driven with the real value — recording is not
    // allowed to change what the executor received.
    expect(calls).toEqual([
      {
        blockId: 'forms',
        data: { selector: '#q', findBy: 'cssSelector', type: 'text-field', value: 'iPhone' },
      },
    ])

    // ...but the NODE holds a reference.
    expect(actionNodeOf('g1')!.data['value']).toBe('{{formsValue}}')

    // ...and the reference has something to resolve against.
    const params = triggerNodeOf('g1')!.data['parameters'] as {
      name: string
      defaultValue: string
    }[]
    expect(params).toEqual([
      expect.objectContaining({ name: 'formsValue', defaultValue: 'iPhone' }),
    ])

    expect(out.dynamicData).toMatchObject({ declared: ['formsValue'] })
  })

  it('references an upstream variable instead of declaring an input', async () => {
    // `get-text` really writes its output into the run's variables; the stub
    // does the same so the bridge sees the value the way it would in practice.
    const { executors } = okExecutors({
      'get-text': async (data, ctx) => {
        ctx.variables[String(data['variableName'])] = 'iPhone 16'
        return null
      },
    })
    await run('g2', 'wf_op_get-text', { selector: '.title', variableName: 'lastTitle' }, executors)
    const out = await run('g2', 'wf_op_forms', { selector: '#q', value: 'iPhone 16' }, executors)

    expect(out.ok).toBe(true)
    if (!out.ok) return
    // The graph can produce this value on its own, so no input is needed.
    expect(nodeFor('g2', 'forms')!.data['value']).toBe('{{lastTitle}}')
    expect(out.dynamicData).toMatchObject({ declared: [] })
    expect(triggerNodeOf('g2')!.data['parameters']).toBeUndefined()
  })

  it('names the input from the model hint when one is given', async () => {
    const { executors } = okExecutors()
    await run(
      'g3',
      'wf_op_forms',
      { selector: '#q', value: 'iPhone', inputName: 'keyword' },
      executors,
    )
    expect(actionNodeOf('g3')!.data['value']).toBe('{{keyword}}')
    // The hint is a model-only affordance and must not reach the node.
    expect(actionNodeOf('g3')!.data['inputName']).toBeUndefined()
  })

  it('leaves structural parameters literal', async () => {
    const { executors } = okExecutors()
    await run('g4', 'wf_op_event-click', { selector: '#submit' }, executors)
    const node = actionNodeOf('g4')!
    expect(node.data['selector']).toBe('#submit')
    expect(node.data['findBy']).toBe('cssSelector')
    expect(triggerNodeOf('g4')!.data['parameters']).toBeUndefined()
  })

  it('a read step produces the value, so the next step references it', async () => {
    // The forms block's read mode is the declarative answer to "read what this
    // field holds" — the demand that used to end in a script. What it reads is
    // an UPSTREAM value, so a later step using it must become {{email}}, not a
    // declared workflow input.
    const readValue = 'ada@example.com'
    const read = await run(
      'g5',
      'wf_op_forms',
      // `value` is deliberately present and stale: in read mode it is not data.
      { selector: '#email', getValue: true, variableName: 'email', value: 'leftover' },
      {
        forms: async (_data, ctx) => {
          ctx.variables['email'] = readValue
          return null
        },
      },
    )
    expect(read.ok).toBe(true)
    const readNode = nodeFor('g5', 'forms')!
    expect(readNode.data['getValue']).toBe(true)
    expect(readNode.data['variableName']).toBe('email')
    // Nothing to declare: the read is the source of the value, not a consumer.
    expect(triggerNodeOf('g5')!.data['parameters'] ?? []).toEqual([])

    const { executors } = okExecutors()
    const write = await run(
      'g5',
      'wf_op_forms',
      { selector: '#copy', type: 'text-field', value: readValue },
      executors,
    )
    expect(write.ok).toBe(true)
    const writeNode = getDraftSnapshot('g5')!.nodes.find((n) => n.data['selector'] === '#copy')!
    expect(writeNode.data['value']).toBe('{{email}}')
  })
})

describe('replay resolves the recorded references', () => {
  const workflowWithInput = (defaultValue: string): Workflow =>
    ({
      id: 'wf',
      name: 'wf',
      createdAt: 0,
      updatedAt: 0,
      drawflow: {
        nodes: [
          {
            id: 't',
            label: 'trigger',
            position: { x: 0, y: 0 },
            data: {
              blockId: 'trigger',
              type: 'manual',
              parameters: [{ name: 'keyword', type: 'string', defaultValue }],
            },
          },
          {
            id: 'n1',
            label: 'forms',
            position: { x: 0, y: 0 },
            data: { blockId: 'forms', value: '{{keyword}}' },
          },
        ],
        edges: [
          {
            id: 'e1',
            source: 't',
            target: 'n1',
            sourceHandle: 'trigger-output-1',
            targetHandle: 'forms-input-1',
          },
        ],
      },
      trigger: {
        type: 'manual',
        parameters: [{ name: 'keyword', type: 'string', defaultValue }],
      },
      settings: { saveLog: false, debugMode: false, notification: false, reuseLastState: false },
    }) as unknown as Workflow

  it('seeds the run scope from the declared input default', async () => {
    engine.runWorkflow.mockResolvedValue({ outcome: 'ok', completedNodeIds: [], summary: 'ok' })
    await executeWorkflow(workflowWithInput('iPhone'), { source: 'manual' })
    const opts = engine.runWorkflow.mock.calls[0]![1] as { variables?: Record<string, unknown> }
    // Without this the whole graph would resolve `{{keyword}}` to nothing.
    expect(opts.variables).toEqual({ keyword: 'iPhone' })
  })

  it('lets a caller-supplied value override the default', async () => {
    engine.runWorkflow.mockResolvedValue({ outcome: 'ok', completedNodeIds: [], summary: 'ok' })
    await executeWorkflow(workflowWithInput('iPhone'), {
      source: 'manual',
      variables: { keyword: 'Android' },
    })
    const opts = engine.runWorkflow.mock.calls[0]![1] as { variables?: Record<string, unknown> }
    expect(opts.variables).toEqual({ keyword: 'Android' })
  })
})

/** A minimal executor context: only the fields the input block touches. */
function makeCtx(variables: Record<string, unknown>): {
  ctx: WorkflowExecCtx
  emitted: { kind: string; text: string }[]
} {
  const emitted: { kind: string; text: string }[] = []
  return {
    emitted,
    ctx: {
      variables,
      refData: undefined,
      signal: new AbortController().signal,
      emit: (kind: string, text: string) => emitted.push({ kind, text }),
    } as unknown as WorkflowExecCtx,
  }
}

describe('parameter-prompt resolves its declared inputs', () => {
  const prompt = EXECUTORS['parameter-prompt']!

  it('fills the scope from a declared default', async () => {
    // The block used to read `prompt`/`defaultValue`/`variableName`, which
    // nothing ever wrote, so it silently contributed an empty string.
    const { ctx } = makeCtx({})
    await prompt({ parameters: [{ name: 'city', type: 'string', defaultValue: '北京' }] }, ctx)
    expect(ctx.variables['city']).toBe('北京')
  })

  it('does not clobber a value the scope already holds', async () => {
    const { ctx } = makeCtx({ city: '上海' })
    await prompt({ parameters: [{ name: 'city', type: 'string', defaultValue: '北京' }] }, ctx)
    expect(ctx.variables['city']).toBe('上海')
  })

  it('coerces a declared numeric default', async () => {
    const { ctx } = makeCtx({})
    await prompt({ parameters: [{ name: 'limit', type: 'number', defaultValue: '10' }] }, ctx)
    expect(ctx.variables['limit']).toBe(10)
  })

  it('fails loudly when a required input has no value', async () => {
    const { ctx, emitted } = makeCtx({})
    await expect(
      prompt({ parameters: [{ name: 'keyword', type: 'string', data: { required: true } }] }, ctx),
    ).rejects.toThrow('Missing required workflow input(s): keyword')
    expect(emitted.some((line) => line.kind === 'error')).toBe(true)
  })

  it('is a no-op when nothing is declared', async () => {
    const { ctx, emitted } = makeCtx({})
    await prompt({}, ctx)
    expect(emitted).toEqual([{ kind: 'info', text: '参数输入：未声明任何参数' }])
  })
})
