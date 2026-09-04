import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWorkflow } from '../src/background/workflow-engine/engine'
import {
  EXECUTORS,
  type WorkflowExecCtx,
} from '../src/background/workflow-engine/executors'
import { streamCompletion } from '../src/lib/llm'
import { getSettings } from '../src/lib/storage'
import { getWorkflow } from '../src/lib/workflow/storage'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

/**
 * Phase 4: non-browser executors plus the engine's `loop-data` /
 * `execute-workflow` special handling. Storage / llm are mocked so the ai-prompt
 * and execute-workflow blocks never touch chrome or a real model.
 */

vi.mock('../src/lib/workflow/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/workflow/storage')>()
  return { ...actual, getWorkflow: vi.fn() }
})

vi.mock('../src/lib/llm', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/llm')>()
  return { ...actual, streamCompletion: vi.fn() }
})

vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return { ...actual, getSettings: vi.fn() }
})

/**
 * JS-expression blocks (javascript-code / condition / conditions / data-mapping
 * / while-loop) evaluate user code in the PAGE in the MV3 build (the service
 * worker CSP forbids `eval`/`new Function`). In tests there is no page, so the
 * driver's page evaluator is replaced with a local `new Function` — the same
 * semantics the engine falls back to when no evaluator is injected.
 */
vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return {
    ...actual,
    execJsOnActiveTab: vi.fn(
      async (code: string, args: Record<string, unknown> = {}) => {
        const names = Object.keys(args)
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        const fn = new Function(...names, `"use strict";\n${code}`)
        try {
          return { ok: true as const, data: fn(...names.map((n) => args[n])) }
        } catch (error) {
          return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
        }
      },
    ),
  }
})

/** Build a minimal Workflow from nodes + edges. */
function makeWorkflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow {
  return {
    id: 'wf',
    name: 'wf',
    createdAt: 0,
    updatedAt: 0,
    drawflow: { nodes, edges },
    settings: {
      saveLog: false,
      debugMode: false,
      notification: false,
      reuseLastState: false,
    },
  }
}

const node = (id: string, label: string, data: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  label,
  position: { x: 0, y: 0 },
  data,
})

const edge = (source: string, target: string, handle?: string): WorkflowEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  ...(handle ? { sourceHandle: handle } : {}),
})

function makeCtx() {
  const emit = vi.fn()
  const ctx: WorkflowExecCtx = {
    variables: {},
    refData: undefined,
    signal: new AbortController().signal,
    emit: emit as unknown as WorkflowExecCtx['emit'],
  }
  return { ctx, emit }
}

describe('workflow phase 4 — data & control-flow blocks via runWorkflow', () => {
  beforeEach(() => {
    vi.mocked(getWorkflow).mockReset()
    vi.mocked(streamCompletion).mockReset()
    vi.mocked(getSettings).mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('set/get/insert/export run end-to-end sharing the variables object', async () => {
    let captured: Record<string, unknown> = {}
    const wf = makeWorkflow(
      [
        node('t', 'manual'),
        node('set', 'set-variable', { variableName: 'name', value: 'world' }),
        node('get', 'get-variable', { variableName: 'name' }),
        node('ins', 'insert-data', { data: '[{"a":1,"b":"x"},{"a":2,"b":"y,z"}]' }),
        node('exp', 'export-data', { format: 'csv' }),
        node('probe', 'probe'),
      ],
      [
        edge('t', 'set'),
        edge('set', 'get'),
        edge('get', 'ins'),
        edge('ins', 'exp'),
        edge('exp', 'probe'),
      ],
    )
    const result = await runWorkflow(wf, {
      executors: {
        ...EXECUTORS,
        probe: async (_d, ctx) => {
          captured = { ...ctx.variables }
          return null
        },
      },
    })

    expect(result.outcome).toBe('ok')
    expect(captured['name']).toBe('world')
    expect(captured['lastValue']).toBe('world')
    expect(captured['dataTable']).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: 'y,z' },
    ])
    // csv: header from the first row's keys; comma-bearing cells are quoted.
    expect(captured['lastExport']).toBe('a,b\n1,x\n2,"y,z"')
  })

  it('javascript-code stores its return value in lastResult', async () => {
    let captured: unknown = null
    const wf = makeWorkflow(
      [node('t', 'manual'), node('js', 'javascript-code', { code: 'return 42' }), node('p', 'probe')],
      [edge('t', 'js'), edge('js', 'p')],
    )
    const result = await runWorkflow(wf, {
      executors: {
        ...EXECUTORS,
        probe: async (_d, ctx) => {
          captured = ctx.variables['lastResult']
          return null
        },
      },
    })
    expect(result.outcome).toBe('ok')
    expect(captured).toBe(42)
  })

  it('trigger blocks are pass-through no-ops that still route onward', async () => {
    let ran = false
    const wf = makeWorkflow([node('t', 'manual'), node('p', 'probe')], [edge('t', 'p')])
    const result = await runWorkflow(wf, {
      executors: {
        ...EXECUTORS,
        probe: async () => {
          ran = true
          return null
        },
      },
    })
    expect(result.outcome).toBe('ok')
    expect(ran).toBe(true)
  })

  it('condition routes to the true edge when the expression is truthy', async () => {
    const calls: string[] = []
    const wf = makeWorkflow(
      [node('t', 'manual'), node('c', 'condition', { code: '1+1===2' }), node('b', 'b'), node('n', 'n')],
      [edge('t', 'c'), edge('c', 'b', 'true'), edge('c', 'n', 'false')],
    )
    await runWorkflow(wf, {
      executors: {
        ...EXECUTORS,
        b: async () => {
          calls.push('b')
          return null
        },
        n: async () => {
          calls.push('n')
          return null
        },
      },
    })
    expect(calls).toEqual(['b'])
  })

  it('condition routes to the false edge when the expression is falsy', async () => {
    const calls: string[] = []
    const wf = makeWorkflow(
      [node('t', 'manual'), node('c', 'condition', { code: '1===2' }), node('b', 'b'), node('n', 'n')],
      [edge('t', 'c'), edge('c', 'b', 'true'), edge('c', 'n', 'false')],
    )
    await runWorkflow(wf, {
      executors: {
        ...EXECUTORS,
        b: async () => {
          calls.push('b')
          return null
        },
        n: async () => {
          calls.push('n')
          return null
        },
      },
    })
    expect(calls).toEqual(['n'])
  })
})

describe('workflow phase 4 — loop-data', () => {
  beforeEach(() => {
    vi.mocked(getWorkflow).mockReset()
  })
  afterEach(() => vi.clearAllMocks())

  it('runs its body once per item, exposing loopIndex / loopItem', async () => {
    const seen: Array<{ index: unknown; item: unknown }> = []
    const wf = makeWorkflow(
      [
        node('t', 'manual'),
        node('loop', 'loop-data', { data: '[10,20,30]' }),
        node('body', 'body'),
        node('exit', 'exit'),
      ],
      [edge('t', 'loop'), edge('loop', 'body'), edge('body', 'exit')],
    )
    const result = await runWorkflow(wf, {
      executors: {
        ...EXECUTORS,
        body: async (_d, ctx) => {
          seen.push({ index: ctx.variables['loopIndex'], item: ctx.variables['loopItem'] })
          return null
        },
        exit: async () => null,
      },
    })
    expect(result.outcome).toBe('ok')
    expect(seen).toEqual([
      { index: 0, item: 10 },
      { index: 1, item: 20 },
      { index: 2, item: 30 },
    ])
  })

  it('repeat-task runs its body a fixed number of times', async () => {
    const seen: unknown[] = []
    const wf = makeWorkflow(
      [
        node('t', 'manual'),
        node('loop', 'repeat-task', { count: 3 }),
        node('body', 'body'),
        node('exit', 'exit'),
      ],
      [edge('t', 'loop'), edge('loop', 'body'), edge('body', 'exit')],
    )
    const result = await runWorkflow(wf, {
      executors: {
        ...EXECUTORS,
        body: async (_d, ctx) => {
          seen.push(ctx.variables['loopIndex'])
          return null
        },
        exit: async () => null,
      },
    })
    expect(result.outcome).toBe('ok')
    expect(seen).toEqual([0, 1, 2])
  })

  it('while-loop runs while its condition holds and terminates when it flips false', async () => {
    const seen: unknown[] = []
    const wf = makeWorkflow(
      [
        node('t', 'manual'),
        node('loop', 'while-loop', { code: 'vars.counter < 3' }),
        node('body', 'body'),
        node('exit', 'exit'),
      ],
      [edge('t', 'loop'), edge('loop', 'body'), edge('body', 'exit')],
    )
    const result = await runWorkflow(wf, {
      variables: { counter: 0 },
      executors: {
        ...EXECUTORS,
        body: async (_d, ctx) => {
          seen.push(ctx.variables['loopIndex'])
          ctx.variables['counter'] = Number(ctx.variables['counter']) + 1
          return null
        },
        exit: async () => null,
      },
    })
    expect(result.outcome).toBe('ok')
    expect(seen).toEqual([0, 1, 2])
  })

  it('loop-elements iterates the count from the loopElementCounter hook', async () => {
    const seen: unknown[] = []
    const wf = makeWorkflow(
      [
        node('t', 'manual'),
        node('loop', 'loop-elements', { cssSelector: '.item' }),
        node('body', 'body'),
        node('exit', 'exit'),
      ],
      [edge('t', 'loop'), edge('loop', 'body'), edge('body', 'exit')],
    )
    const result = await runWorkflow(wf, {
      loopElementCounter: async (selector) => {
        expect(selector).toBe('.item')
        return 3
      },
      executors: {
        ...EXECUTORS,
        body: async (_d, ctx) => {
          seen.push(ctx.variables['loopIndex'])
          return null
        },
        exit: async () => null,
      },
    })
    expect(result.outcome).toBe('ok')
    expect(seen).toEqual([0, 1, 2])
  })
})

describe('workflow phase 4 — execute-workflow', () => {
  beforeEach(() => {
    vi.mocked(getWorkflow).mockReset()
  })
  afterEach(() => vi.clearAllMocks())

  it('runs a referenced sub-workflow then continues on the default edge', async () => {
    const sub = makeWorkflow([node('s', 'sub-body')], [])
    vi.mocked(getWorkflow).mockResolvedValue(sub)

    const order: string[] = []
    const wf = makeWorkflow(
      [
        node('t', 'manual'),
        node('ex', 'execute-workflow', { workflowId: 'sub-1' }),
        node('after', 'after-node'),
      ],
      [edge('t', 'ex'), edge('ex', 'after')],
    )
    const result = await runWorkflow(wf, {
      executors: {
        ...EXECUTORS,
        'sub-body': async () => {
          order.push('sub-body')
          return null
        },
        'after-node': async () => {
          order.push('after')
          return null
        },
      },
    })
    expect(result.outcome).toBe('ok')
    expect(order).toEqual(['sub-body', 'after'])
  })

  it('guards a→a self-loops via parentWorkflowIds', async () => {
    const wf = makeWorkflow(
      [
        node('t', 'manual'),
        node('ex', 'execute-workflow', { workflowId: 'wf-self' }),
        node('after', 'after'),
      ],
      [edge('t', 'ex'), edge('ex', 'after')],
    )
    const steps: string[] = []
    const result = await runWorkflow(wf, {
      parentWorkflowIds: new Set(['wf-self']),
      onStep: (_k, _id, text) => steps.push(text),
      executors: { ...EXECUTORS, after: async () => null },
    })
    expect(result.outcome).toBe('ok')
    expect(vi.mocked(getWorkflow)).not.toHaveBeenCalled()
    expect(steps.some((s) => s.includes('自循环'))).toBe(true)
  })
})

describe('workflow phase 4 — integration executors', () => {
  beforeEach(() => {
    vi.mocked(getSettings).mockReset()
    vi.mocked(streamCompletion).mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('delay resolves after a short wait and emits a status (time key; legacy ms kept)', async () => {
    const { ctx, emit } = makeCtx()
    await EXECUTORS['delay']!({ time: 5 }, ctx)
    expect(emit).toHaveBeenCalledWith('status', expect.stringContaining('延时'))
    // Legacy graphs stored the duration under `ms`.
    const legacy = makeCtx()
    await EXECUTORS['delay']!({ ms: 5 }, legacy.ctx)
    expect(legacy.emit).toHaveBeenCalledWith('status', expect.stringContaining('延时'))
  })

  it('webhook posts the parsed body and emits result', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => 'accepted',
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, emit } = makeCtx()
    await EXECUTORS['webhook']!({ url: 'https://example.com/hook', body: '{"x":1}' }, ctx)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.com/hook')
    expect(JSON.parse(init.body as string)).toEqual({ x: 1 })
    expect(emit).toHaveBeenCalledWith('result', 'POST 200 accepted')
  })

  it('notification creates a chrome notification and emits result', async () => {
    const create = vi.fn(async () => 'notif-id')
    vi.stubGlobal('chrome', { notifications: { create } })
    const { ctx, emit } = makeCtx()
    await EXECUTORS['notification']!({ title: 'Hi', message: 'There' }, ctx)

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Hi', message: 'There' }))
    expect(emit).toHaveBeenCalledWith('result', '已通知')
  })

  it('ai-prompt calls the configured provider and stores lastAIResponse', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      providers: [
        { id: 'p1', label: 'p1', presetId: 'custom', baseUrl: 'https://x', apiKey: 'key', model: 'm' },
      ],
      activeProviderId: 'p1',
    } as unknown as Awaited<ReturnType<typeof getSettings>>)
    vi.mocked(streamCompletion).mockResolvedValue({
      content: 'hello ai',
      toolCalls: [],
      finishReason: 'stop',
      usage: null,
    } as Awaited<ReturnType<typeof streamCompletion>>)

    const { ctx, emit } = makeCtx()
    await EXECUTORS['ai-prompt']!({ prompt: 'hi' }, ctx)

    expect(ctx.variables['lastAIResponse']).toBe('hello ai')
    expect(emit).toHaveBeenCalledWith('result', 'hello ai')
  })

  it('ai-prompt emits an error when no provider is configured', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      providers: [],
      activeProviderId: '',
    } as unknown as Awaited<ReturnType<typeof getSettings>>)

    const { ctx, emit } = makeCtx()
    await EXECUTORS['ai-prompt']!({ prompt: 'hi' }, ctx)

    expect(emit).toHaveBeenCalledWith('error', 'AI 块: 未配置模型给 provider')
  })
})

describe('workflow loops — after-loop "end" branch', () => {
  const CASES: Array<{ blockId: string; data: Record<string, unknown>; vars?: Record<string, unknown> }> = [
    { blockId: 'loop-data', data: { data: '[1,2]' } },
    { blockId: 'repeat-task', data: { count: 2 } },
    { blockId: 'while-loop', data: { code: 'vars.n < 2' }, vars: { n: 0 } },
    { blockId: 'loop-elements', data: { count: 2 } },
  ]

  it.each(CASES)('$blockId runs the end branch once after iterations finish', async ({ blockId, data, vars }) => {
    const seen: string[] = []
    const wf = makeWorkflow(
      [
        node('t', 'manual'),
        node('loop', blockId, data),
        node('body', 'body'),
        node('after', 'after'),
      ],
      [
        edge('t', 'loop'),
        edge('loop', 'body', `${blockId}-output-1`),
        edge('body', 'loop'),
        edge('loop', 'after', `${blockId}-output-2`),
      ],
    )
    const result = await runWorkflow(wf, {
      variables: { ...(vars ?? {}) },
      executors: {
        ...EXECUTORS,
        body: async (_d, ctx) => {
          seen.push('body')
          if (blockId === 'while-loop') {
            ctx.variables['n'] = Number(ctx.variables['n'] ?? 0) + 1
          }
          return null
        },
        after: async () => {
          seen.push('after')
          return null
        },
      },
    })
    expect(result.outcome).toBe('ok')
    expect(seen).toEqual(['body', 'body', 'after'])
  })

  it('while-loop with an immediately-false condition goes straight to the end branch', async () => {
    const seen: string[] = []
    const wf = makeWorkflow(
      [
        node('t', 'manual'),
        node('loop', 'while-loop', { code: 'false' }),
        node('body', 'body'),
        node('after', 'after'),
      ],
      [
        edge('t', 'loop'),
        edge('loop', 'body', 'while-loop-output-1'),
        edge('body', 'loop'),
        edge('loop', 'after', 'while-loop-output-2'),
      ],
    )
    const result = await runWorkflow(wf, {
      executors: {
        ...EXECUTORS,
        body: async () => {
          seen.push('body')
          return null
        },
        after: async () => {
          seen.push('after')
          return null
        },
      },
    })
    expect(result.outcome).toBe('ok')
    expect(seen).toEqual(['after'])
  })

  it('resolves body/end by handle semantics even when the end edge was connected first', async () => {
    const seen: string[] = []
    const wf = makeWorkflow(
      [
        node('t', 'manual'),
        node('loop', 'repeat-task', { count: 2 }),
        node('body', 'body'),
        node('after', 'after'),
      ],
      [
        edge('t', 'loop'),
        edge('loop', 'after', 'repeat-task-output-2'),
        edge('loop', 'body', 'repeat-task-output-1'),
        edge('body', 'loop'),
      ],
    )
    const result = await runWorkflow(wf, {
      executors: {
        ...EXECUTORS,
        body: async () => {
          seen.push('body')
          return null
        },
        after: async () => {
          seen.push('after')
          return null
        },
      },
    })
    expect(result.outcome).toBe('ok')
    expect(seen).toEqual(['body', 'body', 'after'])
  })
})