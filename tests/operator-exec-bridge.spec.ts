import { describe, expect, it, vi } from 'vitest'
import {
  OPERATOR_BLOCK_IDS,
  executeOperatorNode,
  operatorExecClass,
} from '../src/background/workflow-engine/operator-exec'
import { interpolateParams } from '../src/lib/workflow/interpolate'
import { OPERATOR_META } from '../src/lib/tool-catalog'
import { EXECUTORS, type BlockExecutor } from '../src/background/workflow-engine/executors'

const signal = new AbortController().signal

/** An executor registry that records what it was handed. */
function recordingExecutors(behaviour: Record<string, BlockExecutor['prototype'] | unknown> = {}) {
  const calls: { blockId: string; data: Record<string, unknown> }[] = []
  const executors: Record<string, BlockExecutor> = {}
  for (const [blockId, result] of Object.entries(behaviour)) {
    executors[blockId] = async (data, ctx) => {
      calls.push({ blockId, data })
      if (result instanceof Error) throw result
      if (typeof result === 'function') {
        return (result as (data: Record<string, unknown>, ctx: unknown) => string | null)(data, ctx)
      }
      return (result as string | null) ?? null
    }
  }
  return { calls, executors }
}

describe('operatorExecClass', () => {
  it('classifies every operator the model can call', () => {
    for (const blockId of OPERATOR_BLOCK_IDS) {
      const cls = operatorExecClass(blockId)
      expect(cls === 'execute' || cls === 'record-only').toBe(true)
    }
  })

  it('has no duplicate operator ids', () => {
    expect(new Set(OPERATOR_BLOCK_IDS).size).toBe(OPERATOR_BLOCK_IDS.length)
  })

  it('only marks a block executable when a real executor exists', () => {
    // A block classified `execute` with no registry entry would silently
    // degrade to record-only at runtime — a missing step the user never sees.
    const missing = OPERATOR_BLOCK_IDS.filter(
      (id) => operatorExecClass(id) === 'execute' && !EXECUTORS[id],
    )
    expect(missing).toEqual([])
  })

  it('includes the project’s own blocks, not just the imported catalog', () => {
    for (const id of ['ai-agent', 'ocr', 'set-variable', 'get-secret']) {
      expect(OPERATOR_BLOCK_IDS).toContain(id)
    }
  })

  it('drives the settings UI warning from the same classification', () => {
    // The settings panel warns about tools that ACT on the page. Keying that off
    // the block's palette category disagreed with reality in both directions:
    // `proxy` / `browser-event` / `save-local` are catalogued under `browser`
    // but only record a node, while `conditions` / `clipboard` / `delay` are
    // catalogued elsewhere but genuinely run.
    for (const meta of OPERATOR_META) {
      const blockId = meta.name.replace(/^wf_op_/, '')
      expect(`${blockId}:${meta.category}`).toBe(
        `${blockId}:${operatorExecClass(blockId) === 'execute' ? 'act' : 'read'}`,
      )
    }
  })

  it('runs page actions and real waits, records engine-driven blocks', () => {
    for (const id of [
      'event-click',
      'forms',
      'press-key',
      'element-scroll',
      'new-tab',
      'switch-tab',
      'javascript-code',
      'get-secret',
      'element-exists',
      'conditions',
      // A wait is a real wait: the mode operates the page, it does not pretend.
      'delay',
      'wait-connections',
      'ocr',
    ]) {
      expect(`${id}:${operatorExecClass(id)}`).toBe(`${id}:execute`)
    }
    for (const id of [
      'trigger',
      'execute-workflow',
      'loop-elements',
      'repeat-task',
      'while-loop',
      'webhook',
      'notification',
      'save-local',
      'export-data',
      'ai-agent',
      'parameter-prompt',
    ]) {
      expect(`${id}:${operatorExecClass(id)}`).toBe(`${id}:record-only`)
    }
  })
})

describe('interpolateParams', () => {
  it('resolves tokens against the generation-time variables', () => {
    expect(
      interpolateParams({ value: '{{password}}', selector: '#pw' }, { password: 's3cret' }),
    ).toEqual({ value: 's3cret', selector: '#pw' })
  })

  it('leaves non-string values untouched', () => {
    const data = { n: 3, flag: true, plain: 'hello', nested: { a: '{{x}}' } }
    expect(interpolateParams(data, {})).toBe(data)
  })

  it('resolves tokens inside nested objects', () => {
    // Nested params are walked too: a `conditions` row or a rich locator is as
    // legitimate a place for a token as a top-level selector.
    expect(interpolateParams({ nested: { a: '{{x}}' } }, { x: 'y' })).toEqual({
      nested: { a: 'y' },
    })
  })

  it('leaves an unresolved token in place rather than blanking it', () => {
    expect(interpolateParams({ value: '{{missing}}' }, {})).toEqual({ value: '{{missing}}' })
  })
})

describe('executeOperatorNode', () => {
  it('runs the real executor with the block’s params', async () => {
    const { calls, executors } = recordingExecutors({ 'event-click': null })
    const out = await executeOperatorNode(
      'event-click',
      { selector: '#go', findBy: 'cssSelector' },
      { signal, executors },
    )
    expect(out.status).toBe('executed')
    expect(calls).toEqual([
      { blockId: 'event-click', data: { selector: '#go', findBy: 'cssSelector' } },
    ])
  })

  it('reports a failure instead of throwing, so nothing gets recorded', async () => {
    const { executors } = recordingExecutors({ 'event-click': new Error('element not found') })
    const out = await executeOperatorNode(
      'event-click',
      { selector: '#gone' },
      { signal, executors },
    )
    expect(out.status).toBe('failed')
    expect(out.error).toBe('element not found')
  })

  it('echoes what the executor emitted', async () => {
    const executors: Record<string, BlockExecutor> = {
      forms: async (_data, ctx) => {
        ctx.emit('result', '已填写 1 个字段')
        return null
      },
    }
    const out = await executeOperatorNode('forms', { selector: '#q' }, { signal, executors })
    expect(out.lines).toEqual(['已填写 1 个字段'])
  })

  it('records engine-driven blocks without running them', async () => {
    const { calls, executors } = recordingExecutors({ 'loop-elements': null })
    const out = await executeOperatorNode(
      'loop-elements',
      { selector: '.row' },
      { signal, executors },
    )
    expect(out.status).toBe('record-only')
    expect(out.note).toContain('engine')
    expect(calls).toEqual([])
  })

  it('records blocks with off-page side effects without firing them', async () => {
    const { calls, executors } = recordingExecutors({ webhook: null })
    const out = await executeOperatorNode(
      'webhook',
      { url: 'https://x.test' },
      { signal, executors },
    )
    expect(out.status).toBe('record-only')
    expect(out.note).toContain('without sending the request')
    expect(calls).toEqual([])
  })

  it('explains itself when a block has no registered executor', async () => {
    const out = await executeOperatorNode('ocr', { selector: '#img' }, { signal, executors: {} })
    expect(out.status).toBe('record-only')
    expect(out.note).toContain('no executor registered')
  })

  it('reports the port a branch block actually took', async () => {
    const executors: Record<string, BlockExecutor> = {
      'element-exists': async (_data, ctx) => ctx.outputs?.['exists'] ?? null,
      conditions: async (_data, ctx) => ctx.outputs?.['false'] ?? null,
    }
    expect((await executeOperatorNode('element-exists', {}, { signal, executors })).branch).toBe(
      'exists',
    )
    expect(
      (await executeOperatorNode('conditions', { code: '1' }, { signal, executors })).branch,
    ).toBe('false')
  })

  it('does not report a branch for a non-branch block', async () => {
    const { executors } = recordingExecutors({ 'event-click': '__bcBranchTrue' })
    const out = await executeOperatorNode('event-click', {}, { signal, executors })
    expect(out.branch).toBeUndefined()
  })

  it('refuses a conditions block with nothing to evaluate', async () => {
    const { calls, executors } = recordingExecutors({ conditions: null })
    const out = await executeOperatorNode('conditions', { conditions: [] }, { signal, executors })
    expect(out.status).toBe('failed')
    expect(out.error).toContain('nothing to evaluate')
    expect(calls).toEqual([])
  })

  it('accepts a conditions block driven by a code expression', async () => {
    const { calls, executors } = recordingExecutors({ conditions: null })
    const out = await executeOperatorNode(
      'conditions',
      { code: 'vars.n > 1' },
      { signal, executors },
    )
    expect(out.status).toBe('executed')
    expect(calls).toHaveLength(1)
  })

  it('accepts a conditions block driven by condition rows', async () => {
    const { executors } = recordingExecutors({ conditions: null })
    const out = await executeOperatorNode(
      'conditions',
      { conditions: [{ conditions: [{ compare: 'eql', value: 'a' }] }] },
      { signal, executors },
    )
    expect(out.status).toBe('executed')
  })

  it('interpolates params against the generation-time variables before running', async () => {
    const { calls, executors } = recordingExecutors({ forms: null })
    await executeOperatorNode(
      'forms',
      { selector: '#pw', value: '{{password}}' },
      { signal, executors, variables: { password: 's3cret' } },
    )
    expect(calls[0]!.data.value).toBe('s3cret')
  })

  it('mutates the shared variable bag so later calls see it', async () => {
    const executors: Record<string, BlockExecutor> = {
      'set-variable': async (data, ctx) => {
        ctx.variables[String(data.name)] = data.value
        return null
      },
    }
    const variables: Record<string, unknown> = {}
    await executeOperatorNode(
      'set-variable',
      { name: 'total', value: 7 },
      { signal, executors, variables },
    )
    expect(variables).toEqual({ total: 7 })
  })

  it('hands tab pinning back to the caller', async () => {
    const executors: Record<string, BlockExecutor> = {
      'new-tab': async (_data, ctx) => {
        ctx.setTab?.(99)
        return null
      },
    }
    const setTab = vi.fn()
    await executeOperatorNode('new-tab', { url: 'https://x.test' }, { signal, executors, setTab })
    expect(setTab).toHaveBeenCalledWith(99)
  })

  it('passes the run scope through to the executor', async () => {
    const seen: unknown[] = []
    const executors: Record<string, BlockExecutor> = {
      'event-click': async (_data, ctx) => {
        seen.push(ctx.scope)
        return null
      },
    }
    const scope = { windowId: 3 } as never
    await executeOperatorNode('event-click', {}, { signal, executors, scope })
    expect(seen).toEqual([scope])
  })
})
