import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { elementExists, execOnActiveTab } from '../src/background/driver'
import {
  EXECUTORS,
  type WorkflowExecCtx,
} from '../src/background/workflow-engine/executors'
import type { OpResult } from '../src/lib/ops'

/**
 * The driver module is imported for real except `execOnActiveTab`, which we
 * replace so executors never touch the real kernel. Every other driver export
 * (`newTab`, `switchTab`, `closeActiveTab`) keeps its own chrome-backed logic,
 * which is stubbed via the global `chrome` mock below.
 */
vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return {
    ...actual,
    execOnActiveTab: vi.fn(),
    // elementExists reads the page via driver-internal execOnActiveTab, which the
    // module mock above cannot intercept; stub it so branch executors are testable.
    elementExists: vi.fn(async () => 1),
  }
})

const opResult: OpResult = {
  ok: true,
  found: true,
  frameUrl: 'https://example.com/',
  isTopFrame: true,
}

/**
 * In-memory `chrome` double covering every API the browser-class executors
 * reach: tabs query/update/create/reload/remove/captureVisibleTab and
 * scripting.executeScript.
 */
function makeChromeMock() {
  const tab = {
    id: 1,
    windowId: 1,
    url: 'https://example.com/',
    title: 'Example',
    active: true,
  } as unknown as chrome.tabs.Tab
  const query = vi.fn(async () => [tab])
  const update = vi.fn(async () => tab)
  const create = vi.fn(async () => tab)
  const reload = vi.fn(async () => {})
  const remove = vi.fn(async () => {})
  const goBack = vi.fn(async () => {})
  const goForward = vi.fn(async () => {})
  const captureVisibleTab = vi.fn(async () => 'data:image/png;base64,ZZZ')
  const executeScript = vi.fn(async (_details: { target: { tabId: number }; args?: unknown[] }) => [
    { result: 'hello text' },
  ])
  return {
    chrome: {
      tabs: { query, update, create, reload, remove, goBack, goForward, captureVisibleTab },
      scripting: { executeScript },
    },
    refs: { query, update, create, reload, remove, goBack, goForward, captureVisibleTab, executeScript, tab },
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

describe('workflow executors (browser class)', () => {
  let chromeRefs: ReturnType<typeof makeChromeMock>['refs']
  let driverMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    const mock = makeChromeMock()
    chromeRefs = mock.refs
    vi.stubGlobal('chrome', mock.chrome)
    driverMock = vi.mocked(execOnActiveTab)
    driverMock.mockReset()
    driverMock.mockResolvedValue(opResult)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('click resolves the css selector and runs a click op', async () => {
    const { ctx } = makeCtx()
    await EXECUTORS['click']!({ cssSelector: '#btn' }, ctx)

    expect(driverMock).toHaveBeenCalledTimes(1)
    const [op] = driverMock.mock.calls[0]!
    expect(op.action).toBe('click')
    expect(op.target?.primary).toEqual({ how: 'css', value: '#btn' })
  })

  it('fill forwards its value into the op', async () => {
    const { ctx } = makeCtx()
    await EXECUTORS['fill']!({ cssSelector: '#in', value: 'hi' }, ctx)

    const [op] = driverMock.mock.calls[0]!
    expect(op.action).toBe('fill')
    expect(op.target?.primary.value).toBe('#in')
    expect(op.value).toBe('hi')
  })

  it('press-key emits a status before running the op', async () => {
    const { ctx, emit } = makeCtx()
    await EXECUTORS['press-key']!({ key: 'Enter' }, ctx)

    expect(emit).toHaveBeenCalledWith('status', expect.stringContaining('Enter'))
    const [op] = driverMock.mock.calls[0]!
    expect(op.action).toBe('press_key')
    expect(op.value).toBe('Enter')
  })

  it('scroll builds the right scroll spec for a mode', async () => {
    const { ctx } = makeCtx()
    await EXECUTORS['scroll']!({ cssSelector: '#footer', mode: 'bottom' }, ctx)

    const [op] = driverMock.mock.calls[0]!
    expect(op.action).toBe('scroll')
    expect(op.scroll).toEqual({ mode: 'bottom', smooth: false })
    expect(op.target?.primary.value).toBe('#footer')
  })

  it('open-url navigates only for http(s) addresses', async () => {
    const { ctx } = makeCtx()
    await EXECUTORS['open-url']!({ url: 'https://example.com/path' }, ctx)
    expect(chromeRefs.update).toHaveBeenCalledWith(1, { url: 'https://example.com/path' })

    chromeRefs.update.mockClear()
    const { ctx: ctx2, emit } = makeCtx()
    await EXECUTORS['open-url']!({ url: 'file:///C:/x.html' }, ctx2)
    expect(chromeRefs.update).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('error', expect.stringContaining('http'))
  })

  it('take-screenshot stores its data url in variables.lastScreenshot', async () => {
    const { ctx, emit } = makeCtx()
    chromeRefs.captureVisibleTab.mockResolvedValue('data:image/png;base64,XYZ')
    await EXECUTORS['take-screenshot']!({}, ctx)

    expect(chromeRefs.captureVisibleTab).toHaveBeenCalled()
    expect(ctx.variables['lastScreenshot']).toBe('data:image/png;base64,XYZ')
    expect(emit).toHaveBeenCalledWith('result', '已截图')
  })

  it('get-text injects a script and stores variables.lastText', async () => {
    const { ctx } = makeCtx()
    await EXECUTORS['get-text']!({ cssSelector: '.title' }, ctx)

    expect(chromeRefs.executeScript).toHaveBeenCalledTimes(1)
    const [details] = chromeRefs.executeScript.mock.calls[0]!
    expect(details.target.tabId).toBe(1)
    expect(details.args).toEqual(['.title'])
    expect(ctx.variables['lastText']).toBe('hello text')
  })

  it('placeholder blocks emit an unimplemented notice and continue', async () => {
    const { ctx, emit } = makeCtx()
    // loop-data / execute-workflow are engine-handled; their registry entries stay placeholders.
    const next = await EXECUTORS['execute-workflow']!({}, ctx)
    expect(next).toBeNull()
    expect(emit).toHaveBeenCalledWith('info', expect.stringContaining('尚未实现'))
  })

  it('wait-for reports through the op result and driver', async () => {
    const { ctx, emit } = makeCtx()
    await EXECUTORS['wait-for']!({ cssSelector: '[data-ok]' }, ctx)

    const [op] = driverMock.mock.calls[0]!
    expect(op.action).toBe('wait_for')
    expect(emit).toHaveBeenCalledWith('result', '元素已出现')
  })

  it('an aborted signal aborts the step immediately', async () => {
    const controller = new AbortController()
    controller.abort()
    const { ctx } = makeCtx()
    const { emit, ...rest } = ctx
    const aborted: WorkflowExecCtx = { ...rest, signal: controller.signal, emit }

    await expect(EXECUTORS['click']!({ cssSelector: '#x' }, aborted)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Aborted',
    })
    expect(driverMock).not.toHaveBeenCalled()
  })
})

describe('workflow executors (automa-aligned browser actions)', () => {
  let driverMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    const mock = makeChromeMock()
    vi.stubGlobal('chrome', mock.chrome)
    driverMock = vi.mocked(execOnActiveTab)
    driverMock.mockReset()
    driverMock.mockResolvedValue(opResult)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('element-exists routes to the exists edge when the element is found', async () => {
    const { ctx, emit } = makeCtx()
    const branched = { ...ctx, outputs: { exists: 'Y', notExists: 'N' }, defaultNext: 'N' }
    const next = await EXECUTORS['element-exists']!({ cssSelector: '.item' }, branched)

    expect(elementExists).toHaveBeenCalledTimes(1)
    expect(next).toBe('Y')
    expect(emit).toHaveBeenCalledWith('result', expect.stringContaining('元素存在'))
  })

  it('attribute-value get stores the op result in the output variable', async () => {
    driverMock.mockResolvedValue({ ...opResult, data: 'attr-val' })
    const { ctx, emit } = makeCtx()
    await EXECUTORS['attribute-value']!(
      { op: 'get', cssSelector: '#a', attribute: 'href', variableName: 'href' },
      ctx,
    )
    expect(ctx.variables['href']).toBe('attr-val')
    expect(emit).toHaveBeenCalledWith('result', 'attr-val')
  })

  it('trigger-event forwards event name and detail through the op', async () => {
    const { ctx } = makeCtx()
    await EXECUTORS['trigger-event']!(
      { cssSelector: '#btn', event: 'myevent', detail: '{"x":1}' },
      ctx,
    )
    const [op] = driverMock.mock.calls[0]!
    expect(op.action).toBe('trigger_event')
    expect(op.attribute).toBe('myevent')
    expect(op.value).toBe('{"x":1}')
  })

  it('go-back calls the driver back-navigation', async () => {
    // go-back routes through the real `goBack` driver function, not execOnActiveTab.
    const { ctx, emit } = makeCtx()
    await EXECUTORS['go-back']!({}, ctx)
    expect(emit).toHaveBeenCalledWith('result', '已后退')
  })

  it('create-element injects the html through the op', async () => {
    const { ctx } = makeCtx()
    await EXECUTORS['create-element']!({ html: '<div>x</div>' }, ctx)
    const [op] = driverMock.mock.calls[0]!
    expect(op.action).toBe('create_element')
    expect(op.value).toBe('<div>x</div>')
  })
})