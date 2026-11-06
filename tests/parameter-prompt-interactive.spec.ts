/**
 * The interactive half of `parameter-prompt`: the executor asks the hosting
 * page for its declared values instead of silently resolving defaults.
 *
 * The no-hook path (Runner, scheduled / triggered runs) is covered by
 * `dynamic-data-flow.spec.ts`; here every case supplies `requestInput`.
 */
import { describe, expect, it, vi } from 'vitest'
import { runWorkflow } from '../src/background/workflow-engine/engine'
import { EXECUTORS, type WorkflowExecCtx } from '../src/background/workflow-engine/executors'
import type { RunInputPrompt } from '../src/lib/workflow/run-input'
import type { Workflow, WorkflowNode, WorkflowParameter } from '../src/lib/workflow/types'

const parameterPrompt = EXECUTORS['parameter-prompt']!

interface Emitted {
  kind: string
  text: string
}

function makeCtx(
  variables: Record<string, unknown>,
  requestInput?: (
    prompt: RunInputPrompt,
  ) => Promise<{ values: Record<string, string>; cancelled?: boolean; timedOut?: boolean }>,
  presetInputs?: Readonly<Record<string, unknown>>,
): { ctx: WorkflowExecCtx; emitted: Emitted[]; request: ReturnType<typeof vi.fn> } {
  const emitted: Emitted[] = []
  const request = vi.fn(requestInput ?? (async () => ({ values: {} })))
  const ctx = {
    variables,
    refData: undefined,
    signal: new AbortController().signal,
    emit: (kind: string, text: string) => emitted.push({ kind, text }),
    ...(requestInput ? { requestInput: request } : {}),
    ...(presetInputs ? { presetInputs } : {}),
  } as unknown as WorkflowExecCtx
  return { ctx, emitted, request }
}

function param(overrides: Partial<WorkflowParameter> & { name: string }): WorkflowParameter {
  return { type: 'string', ...overrides }
}

describe('parameter-prompt asks the launching page', () => {
  it('sends interpolated fields and the block timeout, then writes the answer', async () => {
    const { ctx, emitted, request } = makeCtx({ greeting: 'hi' }, async () => ({
      values: { city: '上海' },
    }))
    await parameterPrompt(
      {
        description: '请填写 {{greeting}}',
        timeout: 1200,
        parameters: [
          param({ name: 'city', placeholder: 'City', data: { required: true } }),
          param({ name: 'limit', type: 'number', defaultValue: '10' }),
        ],
      },
      ctx,
    )

    expect(request).toHaveBeenCalledTimes(1)
    const prompt = request.mock.calls[0]![0] as RunInputPrompt
    expect(prompt.timeoutMs).toBe(1200)
    expect(prompt.description).toBe('请填写 hi')
    expect(prompt.fields).toEqual([
      {
        name: 'city',
        type: 'string',
        placeholder: 'City',
        value: '',
        required: true,
      },
      { name: 'limit', type: 'number', value: '10', required: false },
    ])
    expect(ctx.variables['city']).toBe('上海')
    // The answered value does not block the default of the untouched field.
    expect(ctx.variables['limit']).toBe(10)
    expect(emitted.some((line) => line.text.includes('city=上海'))).toBe(true)
  })

  it('coerces json and checkbox answers', async () => {
    const { ctx } = makeCtx({}, async () => ({
      values: { config: '{"retries":2}', enabled: 'true' },
    }))
    await parameterPrompt(
      {
        parameters: [
          param({ name: 'config', type: 'json' }),
          param({ name: 'enabled', type: 'checkbox' }),
        ],
      },
      ctx,
    )
    expect(ctx.variables['config']).toEqual({ retries: 2 })
    expect(ctx.variables['enabled']).toBe(true)
  })

  it('keeps existing scope values over the pre-filled dialog text', async () => {
    const { ctx } = makeCtx({ keyword: 'existing' }, async (prompt) => ({
      // What the dialog shows for an untouched field is the scope value; the
      // executor must not treat "answered with the same text" as a change.
      values: Object.fromEntries(prompt.fields.map((field) => [field.name, field.value])),
    }))
    await parameterPrompt({ parameters: [param({ name: 'keyword' })] }, ctx)
    expect(ctx.variables['keyword']).toBe('existing')
  })

  it('continues with defaults when the wait times out', async () => {
    const { ctx, emitted } = makeCtx({}, async () => ({ values: {}, timedOut: true }))
    await parameterPrompt(
      {
        timeout: 5000,
        parameters: [param({ name: 'limit', type: 'number', defaultValue: '25' })],
      },
      ctx,
    )
    expect(ctx.variables['limit']).toBe(25)
    expect(emitted.some((line) => line.text.includes('超时'))).toBe(true)
  })

  it('fails required inputs that are still missing after a timeout', async () => {
    const { ctx } = makeCtx({}, async () => ({ values: {}, timedOut: true }))
    await expect(
      parameterPrompt({ parameters: [param({ name: 'keyword', data: { required: true } })] }, ctx),
    ).rejects.toThrow('Missing required workflow input(s): keyword')
  })

  it('stops the run when the dialog is cancelled', async () => {
    const { ctx, emitted } = makeCtx({}, async () => ({ values: {}, cancelled: true }))
    await expect(
      parameterPrompt({ parameters: [param({ name: 'keyword' })] }, ctx),
    ).rejects.toMatchObject({ name: 'AbortError' })
    // The engine writes the failure line; the executor must not report a result.
    expect(emitted.some((line) => line.kind === 'result')).toBe(false)
  })

  it('never sends or logs a secret value, and a blank answer keeps the stored one', async () => {
    const { ctx, emitted, request } = makeCtx({ apiKey: 'stored-token' }, async () => ({
      values: { apiKey: '' },
    }))
    await parameterPrompt(
      {
        parameters: [
          param({
            name: 'apiKey',
            secret: true,
            defaultValue: 'default-token',
            data: { required: true },
          }),
        ],
      },
      ctx,
    )

    const prompt = request.mock.calls[0]![0] as RunInputPrompt
    expect(prompt.fields[0]).toMatchObject({ value: '', secret: true, secretStored: true })

    expect(ctx.variables['apiKey']).toBe('stored-token')
    const result = emitted.find((line) => line.kind === 'result')!
    expect(result.text).toBe('apiKey=***')
    expect(result.text).not.toContain('stored-token')
  })

  it('marks a secret with nothing stored as not stored', async () => {
    const { ctx, request } = makeCtx({}, async () => ({ values: { apiKey: 'new-token' } }))
    await parameterPrompt({ parameters: [param({ name: 'apiKey', secret: true })] }, ctx)
    const prompt = request.mock.calls[0]![0] as RunInputPrompt
    expect(prompt.fields[0]!.secretStored).toBeUndefined()
    expect(ctx.variables['apiKey']).toBe('new-token')
  })

  it('asks only for the values the workflow panel did not save', async () => {
    const { ctx, request } = makeCtx(
      { keyword: 'iPhone' },
      async () => ({ values: { city: '上海' } }),
      { keyword: 'iPhone' },
    )
    await parameterPrompt(
      {
        parameters: [param({ name: 'keyword' }), param({ name: 'city' })],
      },
      ctx,
    )

    const prompt = request.mock.calls[0]![0] as RunInputPrompt
    expect(prompt.fields.map((field) => field.name)).toEqual(['city'])
    expect(ctx.variables['city']).toBe('上海')
    // The saved value survives untouched.
    expect(ctx.variables['keyword']).toBe('iPhone')
  })

  it('asks nothing when every declared value was saved in the panel', async () => {
    const { ctx, emitted, request } = makeCtx({ keyword: 'iPhone' }, async () => ({ values: {} }), {
      keyword: 'iPhone',
    })
    await parameterPrompt({ parameters: [param({ name: 'keyword' })] }, ctx)

    expect(request).not.toHaveBeenCalled()
    expect(emitted.some((line) => line.text.includes('已保存的参数值'))).toBe(true)
    expect(ctx.variables['keyword']).toBe('iPhone')
  })

  it('falls back to a 60-second wait for a missing timeout', async () => {
    const { ctx, request } = makeCtx({}, async () => ({ values: { a: '1' } }))
    await parameterPrompt({ parameters: [param({ name: 'a' })] }, ctx)
    const prompt = request.mock.calls[0]![0] as RunInputPrompt
    expect(prompt.timeoutMs).toBe(60_000)
  })
})

describe('parameter-prompt without a host hook', () => {
  it('keeps the silent default-filling behavior', async () => {
    const { ctx, emitted } = makeCtx({})
    await parameterPrompt({ parameters: [param({ name: 'city', defaultValue: '北京' })] }, ctx)
    expect(ctx.variables['city']).toBe('北京')
    expect(emitted.some((line) => line.text === '参数输入：等待填写…')).toBe(false)
  })
})

describe('parameter-prompt through the engine', () => {
  function graph(nodes: WorkflowNode[]): Workflow {
    return {
      id: 'wf',
      name: 'wf',
      createdAt: 0,
      updatedAt: 0,
      drawflow: { nodes, edges: [] },
      settings: {
        saveLog: false,
        debugMode: false,
        notification: false,
        reuseLastState: false,
      },
    }
  }

  it('threads the run hook through runCore into the real executor', async () => {
    const requestInput = vi.fn(async (_prompt: RunInputPrompt) => ({ values: { city: '上海' } }))
    const result = await runWorkflow(
      graph([
        {
          id: 'a',
          label: 'parameter-prompt',
          position: { x: 0, y: 0 },
          data: {
            blockId: 'parameter-prompt',
            timeout: 3000,
            parameters: [param({ name: 'city', data: { required: true } })],
          },
        },
      ]),
      { requestInput },
    )

    expect(requestInput).toHaveBeenCalledTimes(1)
    expect(requestInput.mock.calls[0]![0]).toMatchObject({ timeoutMs: 3000 })
    expect(result.outcome).toBe('ok')
    expect(result.variables?.['city']).toBe('上海')
  })
})
