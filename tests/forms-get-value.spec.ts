import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execOnActiveTab } from '../src/background/driver'
import { EXECUTORS, type WorkflowExecCtx } from '../src/background/workflow-engine/executors'
import { BLOCK_BY_ID } from '../src/lib/workflow/blocks/palette'
import { dataSchemaFromEntry } from '../src/lib/workflow/operator-tools'
import { dataValueSites } from '../src/lib/workflow/data-params'
import type { OpResult } from '../src/lib/ops'

/**
 * The driver module is imported for real except `execOnActiveTab`, which is
 * replaced so executors never reach the real kernel.
 */
vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return { ...actual, execOnActiveTab: vi.fn() }
})

const opResult: OpResult = {
  ok: true,
  found: true,
  frameUrl: 'https://example.com/',
  isTopFrame: true,
}

function makeChromeMock() {
  const tab = { id: 1, windowId: 1, url: 'https://example.com/', active: true }
  // `get-text`'s injected reader returns one entry per matched element, so the
  // stub mirrors that shape — a bare string here would make the executor's
  // single-read path look like it produced nothing.
  const executeScript = vi.fn(async () => [{ result: ['hello text'] as unknown }])
  return {
    chrome: {
      tabs: {
        query: vi.fn(async () => [tab]),
        get: vi.fn(async () => tab),
        update: vi.fn(async () => tab),
        create: vi.fn(async () => tab),
        reload: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
      scripting: { executeScript },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
    executeScript,
  }
}

function makeCtx() {
  const emit = vi.fn((_kind: 'status' | 'result' | 'error' | 'info', _text: string) => {})
  const ctx: WorkflowExecCtx = {
    variables: {},
    refData: undefined,
    signal: new AbortController().signal,
    emit: emit as unknown as WorkflowExecCtx['emit'],
  }
  return { ctx, emit }
}

let driverMock: ReturnType<typeof vi.fn>
let chromeRefs: ReturnType<typeof makeChromeMock>

beforeEach(() => {
  chromeRefs = makeChromeMock()
  vi.stubGlobal('chrome', chromeRefs.chrome)
  driverMock = vi.mocked(execOnActiveTab)
  driverMock.mockReset()
  driverMock.mockResolvedValue(opResult)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const errorsOf = (emit: ReturnType<typeof makeCtx>['emit']) =>
  emit.mock.calls.filter(([kind]) => kind === 'error').map(([, text]) => text)

/**
 * `forms` has offered a "Get form value" toggle in the editor since the port,
 * but the executor never implemented it: the block fell through to the WRITE
 * path with an empty `value`, which cleared the very field the user wanted to
 * read and set no variable at all. A workflow that read a field had to be
 * written as a script — the single most common reason a generated workflow
 * needed code.
 */
describe('forms block: get form value mode', () => {
  it('reads the control into the named variable instead of writing to it', async () => {
    driverMock.mockResolvedValue({ ...opResult, data: 'alice@example.com' })
    const { ctx, emit } = makeCtx()

    await EXECUTORS['forms']!({ cssSelector: '#email', getValue: true, variableName: 'email' }, ctx)

    const [op] = driverMock.mock.calls[0]!
    expect(op.action).toBe('get_value')
    expect(op.target?.primary).toEqual({ how: 'css', value: '#email' })
    expect(ctx.variables['email']).toBe('alice@example.com')
    expect(errorsOf(emit)).toEqual([])
  })

  it('never runs a fill op — that is what used to wipe the field', async () => {
    const { ctx } = makeCtx()

    await EXECUTORS['forms']!({ cssSelector: '#email', getValue: true, variableName: 'email' }, ctx)

    expect(driverMock.mock.calls.map(([op]) => op.action)).toEqual(['get_value'])
    expect(driverMock.mock.calls.some(([op]) => op.action === 'fill')).toBe(false)
  })

  it('keeps the value’s native type', async () => {
    for (const value of [true, false, ['x', 'z'], '']) {
      driverMock.mockResolvedValue({ ...opResult, data: value })
      const { ctx } = makeCtx()
      await EXECUTORS['forms']!({ cssSelector: '#f', getValue: true, variableName: 'v' }, ctx)
      expect(ctx.variables['v']).toBe(value)
    }
  })

  it('refuses to run without a variable name, and says so', async () => {
    const { ctx } = makeCtx()

    await expect(
      EXECUTORS['forms']!({ cssSelector: '#email', getValue: true }, ctx),
    ).rejects.toThrow(/variableName/)

    // Nothing was dispatched: a read with nowhere to put the value is a
    // configuration error, not a page interaction.
    expect(driverMock).not.toHaveBeenCalled()
  })

  it('fails a failed read and leaves the variable unset', async () => {
    driverMock.mockResolvedValue({
      ...opResult,
      ok: false,
      error: 'No element matched. Tried: #email',
    })
    const { ctx } = makeCtx()

    // Thrown, not merely logged: the engine's onError machinery only sees a
    // failure if the executor throws.
    await expect(
      EXECUTORS['forms']!({ cssSelector: '#email', getValue: true, variableName: 'v' }, ctx),
    ).rejects.toThrow(/No element matched/)

    expect(ctx.variables['v']).toBeUndefined()
  })

  it('still writes when the mode is off', async () => {
    const { ctx } = makeCtx()

    await EXECUTORS['forms']!({ cssSelector: '#email', value: 'a@b.c' }, ctx)

    const [op] = driverMock.mock.calls[0]!
    expect(op.action).toBe('fill')
    expect(op.value).toBe('a@b.c')
  })
})

/**
 * `get-text` declared `variableName` in its catalog entry, its editor form and
 * the operator guide — but only ever wrote `lastText`, so a generated node that
 * named its variable produced a reference that resolved to nothing.
 */
describe('get-text honours its declared output variable', () => {
  it('writes the declared name and keeps lastText in step', async () => {
    const { ctx } = makeCtx()

    await EXECUTORS['get-text']!({ cssSelector: '.title', variableName: 'title' }, ctx)

    expect(ctx.variables['title']).toBe('hello text')
    expect(ctx.variables['lastText']).toBe('hello text')
  })

  it('falls back to lastText when no name is given', async () => {
    const { ctx } = makeCtx()

    await EXECUTORS['get-text']!({ cssSelector: '.title' }, ctx)

    expect(ctx.variables['lastText']).toBe('hello text')
    expect(Object.keys(ctx.variables)).toEqual(['lastText'])
  })
})

/**
 * The model has to be able to ASK for the read mode, otherwise the executor fix
 * is unreachable from a generated workflow.
 */
describe('read mode is reachable from the operator tool surface', () => {
  const formsEntry = BLOCK_BY_ID.get('forms')!

  it('exposes `getValue` with an explanation, not as an editor-only key', () => {
    const schema = dataSchemaFromEntry(formsEntry) as {
      properties: Record<string, { type?: string; description?: string }>
    }

    expect(schema.properties['getValue']).toEqual({
      type: 'boolean',
      description: expect.stringContaining('READ mode'),
    })
    expect(schema.properties['variableName']).toBeDefined()
  })

  it('does not treat `value` as business data while in read mode', () => {
    // A leftover value in read mode is not data: rewriting it would declare a
    // workflow input that nothing consumes.
    expect(dataValueSites('forms', { getValue: true, value: 'leftover' })).toEqual([])
    expect(dataValueSites('forms', { value: 'typed' })).toEqual([
      { path: ['value'], value: 'typed' },
    ])
  })
})
