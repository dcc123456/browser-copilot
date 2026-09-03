import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWorkflow } from '../src/background/workflow-engine/engine'
import { interpolate } from '../src/lib/workflow/interpolate'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../src/lib/workflow/types'

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

const node = (id: string, label: string): WorkflowNode => ({
  id,
  label,
  position: { x: 0, y: 0 },
  data: {},
})

const edge = (source: string, target: string, handle?: string): WorkflowEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  ...(handle ? { sourceHandle: handle } : {}),
})

/** An executor that just records it ran and follows the default edge. */
function trace(label: string, order: string[]) {
  return async () => {
    order.push(label)
    return null
  }
}

describe('workflow engine', () => {
  afterEach(() => vi.restoreAllMocks())

  it('runs a linear a → b → c chain and reports completed node ids', async () => {
    const order: string[] = []
    const wf = makeWorkflow(
      [node('a', 'step-a'), node('b', 'step-b'), node('c', 'step-c')],
      [edge('a', 'b'), edge('b', 'c')],
    )
    const result = await runWorkflow(wf, {
      executors: {
        'step-a': trace('a', order),
        'step-b': trace('b', order),
        'step-c': trace('c', order),
      },
    })
    expect(order).toEqual(['a', 'b', 'c'])
    expect(result.outcome).toBe('ok')
    expect(result.completedNodeIds).toEqual(['a', 'b', 'c'])
  })

  it('threads the panel-window scope onto every block ctx (and omits it when absent)', async () => {
    const seen: (unknown)[] = []
    const wf = makeWorkflow([node('a', 'step-a'), node('b', 'step-b')], [edge('a', 'b')])
    const executors = {
      'step-a': async (_data: Record<string, unknown>, ctx: { scope?: unknown }) => {
        seen.push(ctx.scope)
        return null
      },
      'step-b': async (_data: Record<string, unknown>, ctx: { scope?: unknown }) => {
        seen.push(ctx.scope)
        return null
      },
    }
    await runWorkflow(wf, { executors, scope: { windowId: 7 } })
    expect(seen).toEqual([{ windowId: 7 }, { windowId: 7 }])

    seen.length = 0
    await runWorkflow(wf, { executors })
    expect(seen).toEqual([undefined, undefined])
  })

  it('routes through a branch executor to the edge it returns', async () => {
    const order: string[] = []
    // picks outputs['true'] when flag is set, else outputs['false']
    const wf = makeWorkflow(
      [node('start', 'start'), node('cond', 'condition'), node('yes', 'yay'), node('no', 'nay')],
      [edge('start', 'cond'), edge('cond', 'yes', 'true'), edge('cond', 'no', 'false')],
    )
    const result = await runWorkflow(wf, {
      variables: { flag: true },
      executors: {
        start: trace('start', order),
        condition: async (_data, ctx) => {
          order.push('cond')
          return (ctx.variables['flag'] ? ctx.outputs!['true'] : ctx.outputs!['false']) ?? null
        },
        yay: trace('yes', order),
        nay: trace('no', order),
      },
    })
    expect(order).toEqual(['start', 'cond', 'yes'])
    expect(result.completedNodeIds).toEqual(['start', 'cond', 'yes'])
    expect(result.outcome).toBe('ok')
  })

  it('cancels via an aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const wf = makeWorkflow([node('a', 'step-a')], [])
    const result = await runWorkflow(wf, {
      signal: controller.signal,
      executors: { 'step-a': trace('a', []) },
    })
    expect(result.outcome).toBe('cancelled')
    expect(result.completedNodeIds).toEqual([])
  })

  it('treats an executor throwing AbortError as cancelled', async () => {
    const controller = new AbortController()
    const wf = makeWorkflow([node('a', 'boom')], [])
    const result = await runWorkflow(wf, {
      // signal not yet aborted; the executor itself throws AbortError.
      signal: controller.signal,
      executors: {
        boom: async () => {
          controller.abort()
          throw new DOMException('Aborted', 'AbortError')
        },
      },
    })
    expect(result.outcome).toBe('cancelled')
    expect(result.completedNodeIds).toEqual([])
  })

  it('a missing executor marks the run as failed', async () => {
    const wf = makeWorkflow([node('a', 'not-registered')], [])
    const steps: string[] = []
    const result = await runWorkflow(wf, {
      onStep: (_k, _id, text) => steps.push(text),
    })
    expect(result.outcome).toBe('failed')
    expect(result.completedNodeIds).toEqual([])
    expect(steps.some((s) => s.includes('没有找到块执行器'))).toBe(true)
  })

  it('dispatches by data.blockId and reads params from data.values (editor shape)', async () => {
    // Reproduces the saved-graph shape where `label` is the localized display
    // name (e.g. "手动运行") and user params live under data.values. The engine
    // must resolve the executor via blockId and hand the executor the values bag.
    const seen: Array<{ id: string; url?: unknown }> = []
    const wf = makeWorkflow(
      [
        {
          id: 'trigger',
          label: '手动运行',
          position: { x: 0, y: 0 },
          data: { blockId: 'manual', values: {} },
        },
        {
          id: 'open',
          label: 'open-url',
          position: { x: 0, y: 0 },
          data: { blockId: 'open-url', values: { url: 'https://github.com/pulls/review-requested' } },
        },
      ],
      [edge('trigger', 'open')],
    )
    const result = await runWorkflow(wf, {
      executors: {
        manual: async () => null,
        'open-url': async (data) => {
          seen.push({ id: 'open-url', url: data['url'] })
          return null
        },
      },
    })
    expect(result.outcome).toBe('ok')
    expect(result.completedNodeIds).toEqual(['trigger', 'open'])
    expect(seen).toEqual([{ id: 'open-url', url: 'https://github.com/pulls/review-requested' }])
  })

  it('guards against dead loops once MAX_STEPS is exceeded', async () => {
    const order: string[] = []
    const wf = makeWorkflow([node('a', 'walk'), node('b', 'walk')], [edge('a', 'b'), edge('b', 'a')])
    const steps: string[] = []
    const result = await runWorkflow(wf, {
      onStep: (_k, _id, text) => steps.push(text),
      executors: { walk: trace('x', order) },
    })
    expect(result.outcome).toBe('failed')
    expect(result.completedNodeIds.length).toBeGreaterThan(1000)
    expect(steps.some((s) => s.includes('死循环'))).toBe(true)
  })
})

describe('interpolate', () => {
  it('resolves plain and nested variable tokens', () => {
    expect(interpolate('hi {{name}}', { name: 'ralf' })).toBe('hi ralf')
    expect(interpolate('{{user.email}}', { user: { email: 'a@b.c' } })).toBe('a@b.c')
  })

  it('resolves the special refData key (and its nested keys)', () => {
    expect(interpolate('row {{refData}}', {}, { id: 7 })).toBe('row [object Object]')
    expect(interpolate('row {{refData.id}}', {}, { id: 7 })).toBe('row 7')
  })

  it('preserves unmatched placeholders unchanged', () => {
    expect(interpolate('{{missing}} and {{a.b}}', { a: {} })).toBe('{{missing}} and {{a.b}}')
  })

  it('stringifies function values', () => {
    const fn = () => 42
    expect(interpolate('{{fn}}', { fn })).toContain('=> 42')
  })
})