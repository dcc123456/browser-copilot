import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execOnActiveTab } from '../src/background/driver'
import { EXECUTORS, type WorkflowExecCtx } from '../src/background/workflow-engine/executors'

/**
 * The driver module is imported for real except `execOnActiveTab`, which every
 * browser op routes through — replaced so tests never touch the kernel.
 */
vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return { ...actual, execOnActiveTab: vi.fn() }
})

function makeCtx(variables: Record<string, unknown> = {}) {
  const emit = vi.fn((_kind: 'status' | 'result' | 'error' | 'info', _text: string) => {})
  const ctx: WorkflowExecCtx = {
    variables,
    refData: undefined,
    signal: new AbortController().signal,
    emit: emit as unknown as WorkflowExecCtx['emit'],
  }
  return { ctx, emit }
}

const opResult = { ok: true, found: true, frameUrl: 'https://example.com/', isTopFrame: true }

describe('forms block: {{variable}} value handling', () => {
  let driverMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    driverMock = vi.mocked(execOnActiveTab)
    driverMock.mockReset()
    driverMock.mockResolvedValue(opResult)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const formsData = (value: unknown) => ({
    selector: '#q',
    findBy: 'cssSelector',
    type: 'text-field',
    value,
    clearValue: true,
  })

  it('skips the fill with an error when the AI variable resolved to empty', async () => {
    // Mirrors the replay path of an ai-agent step whose generation failed:
    // ctx.variables[variable] is pre-set to '' instead of staying undefined.
    const { ctx, emit } = makeCtx({ aiFill1: '' })
    const next = await EXECUTORS['forms']!(formsData('{{aiFill1}}'), ctx)

    expect(next).toBeNull()
    expect(driverMock).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('error', '表单值引用的变量/AI 结果为空，已跳过本次填写')
  })

  it('interpolates a non-empty AI variable into the fill op', async () => {
    const { ctx, emit } = makeCtx({ aiFill1: 'hello ai' })
    const next = await EXECUTORS['forms']!(formsData('{{aiFill1}}'), ctx)

    expect(next).toBeNull()
    expect(driverMock).toHaveBeenCalledTimes(1)
    const [op] = driverMock.mock.calls[0]!
    expect(op).toEqual({
      action: 'fill',
      target: { primary: { how: 'css', value: '#q' }, fallbacks: [] },
      value: 'hello ai',
      clear: true,
    })
    expect(emit).toHaveBeenCalledWith('result', 'ok')
  })

  it('never trips the guard for a plain literal value', async () => {
    const { ctx } = makeCtx()
    await EXECUTORS['forms']!(formsData('plain text'), ctx)

    const [op] = driverMock.mock.calls[0]!
    expect(op.action).toBe('fill')
    expect(op.value).toBe('plain text')
  })
})

describe('wait-connections block', () => {
  let driverMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    driverMock = vi.mocked(execOnActiveTab)
    driverMock.mockReset()
    driverMock.mockResolvedValue(opResult)
    // Minimal chrome double: no tabs.onUpdated, so the tab-loaded wait inside
    // the block resolves immediately after its 300ms navigation settle window.
    vi.stubGlobal('chrome', { tabs: {} })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reports 页面已加载 and dispatches no op', async () => {
    const { ctx, emit } = makeCtx()
    const withTab: WorkflowExecCtx = { ...ctx, tabId: 7 }

    const next = await EXECUTORS['wait-connections']!({ timeout: 10000 }, withTab)

    expect(next).toBeNull()
    expect(emit).toHaveBeenCalledWith('result', '页面已加载')
    expect(driverMock).not.toHaveBeenCalled()
  })
})
