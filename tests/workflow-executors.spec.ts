import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { elementExists, execOnActiveTab, ocrImage } from '../src/background/driver'
import {
  EXECUTORS,
  cropRectFor,
  type WorkflowExecCtx,
} from '../src/background/workflow-engine/executors'
import type { OpResult } from '../src/lib/ops'

/**
 * The driver module is imported for real except `execOnActiveTab`, which we
 * replace so executors never touch the real kernel. Every other driver export
 * (`newTab`, `switchTab`, `closeActiveTab`) keeps its own chrome-backed logic,
 * which is stubbed via the global `chrome` mock below. `ocrImage` (the local
 * Tesseract OCR via the offscreen document) is stubbed too so OCR-block tests
 * never need the offscreen runtime.
 */
vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return {
    ...actual,
    execOnActiveTab: vi.fn(),
    // elementExists reads the page via driver-internal execOnActiveTab, which the
    // module mock above cannot intercept; stub it so branch executors are testable.
    elementExists: vi.fn(async () => 1),
    ocrImage: vi.fn(async () => ({ ok: true, text: '', confidence: 0 })),
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
    { result: 'hello text' as unknown },
  ])
  return {
    chrome: {
      tabs: { query, update, create, reload, remove, goBack, goForward, captureVisibleTab },
      scripting: { executeScript },
      // getSettings() (used by the ai-prompt and ocr blocks) reads storage.
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {},
        },
      },
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

  it('click surfaces a failed op as a block error instead of success', async () => {
    // The kernel reports failures in-band (ok:false + error), never by throwing.
    driverMock.mockResolvedValue({
      ...opResult,
      ok: false,
      found: false,
      error: 'No element matched. Tried: #nope',
    })
    const { ctx, emit } = makeCtx()
    await expect(EXECUTORS['click']!({ cssSelector: '#nope' }, ctx)).rejects.toThrow(
      'No element matched',
    )
    expect(emit).not.toHaveBeenCalled()
  })

  it('a click that navigated mid-call (ok:true + note) still succeeds', async () => {
    driverMock.mockResolvedValue({
      ...opResult,
      note: 'The page navigated during this step.',
      mayNavigate: true,
    })
    const { ctx, emit } = makeCtx()
    await EXECUTORS['click']!({ cssSelector: '#nav' }, ctx)
    expect(emit).toHaveBeenCalledWith('result', 'The page navigated during this step.')
  })

  it('a rich conversation target becomes fallbacks behind the editable selector', async () => {
    const { ctx } = makeCtx()
    await EXECUTORS['event-click']!(
      {
        selector: '.btn',
        findBy: 'cssSelector',
        target: {
          primary: { how: 'css', value: '.btn' },
          fallbacks: [{ how: 'role', value: 'Buy', role: 'button' }],
        },
      },
      ctx,
    )
    const [op] = driverMock.mock.calls[0]!
    expect(op.target?.primary).toEqual({ how: 'css', value: '.btn' })
    expect(op.target?.fallbacks).toEqual([{ how: 'role', value: 'Buy', role: 'button' }])
  })

  it('with no selector the rich target is used as-is (role/text replay)', async () => {
    const { ctx } = makeCtx()
    const target = {
      primary: { how: 'role', value: '提交', role: 'button' },
      fallbacks: [{ how: 'text', value: '提交' }],
    }
    await EXECUTORS['event-click']!({ selector: '', findBy: 'cssSelector', target }, ctx)
    const [op] = driverMock.mock.calls[0]!
    expect(op.target?.primary).toEqual(target.primary)
    expect(op.target?.fallbacks).toEqual(target.fallbacks)
  })

  it('wait-for surfaces a timeout as a block error', async () => {
    driverMock.mockResolvedValue({ ...opResult, ok: false, found: false, error: 'no match' })
    const { ctx, emit } = makeCtx()
    await expect(EXECUTORS['wait-for']!({ cssSelector: '[data-ok]' }, ctx)).rejects.toThrow(
      '等待超时',
    )
    expect(emit).not.toHaveBeenCalled()
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

describe('workflow ocr block', () => {
  let chromeRefs: ReturnType<typeof makeChromeMock>['refs']
  let driverMock: ReturnType<typeof vi.fn>
  let ocrMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    const mock = makeChromeMock()
    chromeRefs = mock.refs
    vi.stubGlobal('chrome', mock.chrome)
    driverMock = vi.mocked(execOnActiveTab)
    driverMock.mockReset()
    driverMock.mockResolvedValue(opResult)
    ocrMock = vi.mocked(ocrImage)
    ocrMock.mockReset()
    ocrMock.mockResolvedValue({ ok: true, text: '  AB12  ', confidence: 88.4 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('page source captures the visible tab, stores the trimmed text, and reports confidence', async () => {
    chromeRefs.captureVisibleTab.mockResolvedValue('data:image/png;base64,PAGE')
    const { ctx, emit } = makeCtx()
    await EXECUTORS['ocr']!({}, ctx)

    expect(chromeRefs.captureVisibleTab).toHaveBeenCalledWith(1, { format: 'png' })
    // preprocessImage is a no-op without OffscreenCanvas, so the captured
    // data URL reaches the OCR call as-is.
    expect(ocrMock).toHaveBeenCalledWith('data:image/png;base64,PAGE', 'eng')
    expect(ctx.variables['lastOcrText']).toBe('AB12')
    expect(emit).toHaveBeenCalledWith('result', expect.stringContaining('AB12'))
    expect(emit).toHaveBeenCalledWith('result', expect.stringContaining('88'))
  })

  it('element source scrolls into view, then captures the selector in-page for OCR', async () => {
    driverMock.mockResolvedValue({ ...opResult, data: 'data:image/png;base64,EL' })
    const { ctx } = makeCtx()
    await EXECUTORS['ocr']!({ source: 'element', selector: 'img.captcha' }, ctx)

    // First op scrolls the element into view (shadow-piercing kernel target)…
    const [scrollOp] = driverMock.mock.calls[0]!
    expect(scrollOp.action).toBe('scroll')
    expect(scrollOp.target).toEqual({
      primary: { how: 'css', value: 'img.captcha' },
      fallbacks: [],
    })
    // …then the capture op polls (`waitFor`) for late-rendered elements.
    const [captureOp] = driverMock.mock.calls[1]!
    expect(captureOp.action).toBe('capture')
    expect(captureOp.value).toBe('img.captcha')
    expect(captureOp.waitFor).toBe(2000)
    expect(ocrMock).toHaveBeenCalledWith('data:image/png;base64,EL', 'eng')
    expect(ctx.variables['lastOcrText']).toBe('AB12')
  })

  it('element source retries the capture and reports a precise error when the element never appears', async () => {
    // The in-page SVG capture is blocked (e.g. page CSP forbidding data: images)
    // AND the element is absent from the top document (iframe / late render).
    // The block retries, then reports WHY instead of an opaque failure.
    driverMock.mockResolvedValue({ ...opResult, ok: false, error: 'capture: SVG 加载失败' })
    chromeRefs.executeScript.mockResolvedValue([{ result: null }])
    const { ctx, emit } = makeCtx()
    await EXECUTORS['ocr']!({ source: 'element', selector: 'img.captcha' }, ctx)

    expect(ocrMock).not.toHaveBeenCalled()
    // 3 attempts × (scroll + capture).
    expect(driverMock.mock.calls).toHaveLength(6)
    expect(emit).toHaveBeenCalledWith('error', expect.stringContaining('找不到元素'))
    expect(emit).toHaveBeenCalledWith('error', expect.stringContaining('iframe'))
  })

  it('variable source reads an image data URL from the named variable', async () => {
    const { ctx } = makeCtx()
    ctx.variables['shot'] = 'data:image/png;base64,VAR'
    await EXECUTORS['ocr']!({ source: 'variable', imageVariable: 'shot' }, ctx)

    expect(chromeRefs.captureVisibleTab).not.toHaveBeenCalled()
    expect(driverMock).not.toHaveBeenCalled()
    expect(ocrMock).toHaveBeenCalledWith('data:image/png;base64,VAR', 'eng')
  })

  it('variable source wraps a bare base64 payload into a data URL for the canvas', async () => {
    const { ctx } = makeCtx()
    const b64 = 'A'.repeat(64)
    ctx.variables['shot'] = b64
    await EXECUTORS['ocr']!({ source: 'variable', imageVariable: 'shot' }, ctx)

    expect(ocrMock).toHaveBeenCalledWith(`data:image/png;base64,${b64}`, 'eng')
    expect(ctx.variables['lastOcrText']).toBe('AB12')
  })

  it('variable source fetches an http(s) image link and re-encodes it as a data URL', async () => {
    const bytes = new TextEncoder().encode('fake-png-bytes')
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => bytes.buffer,
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { ctx } = makeCtx()
    ctx.variables['shot'] = 'https://example.com/captcha.png'
    await EXECUTORS['ocr']!({ source: 'variable', imageVariable: 'shot' }, ctx)

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/captcha.png', expect.anything())
    const [dataUrl] = ocrMock.mock.calls[0]!
    expect(String(dataUrl)).toMatch(/^data:image\/png;base64,/)
    expect(ctx.variables['lastOcrText']).toBe('AB12')
  })

  it('variable source errors on a value that is not an image reference', async () => {
    const { ctx, emit } = makeCtx()
    ctx.variables['shot'] = 'not-an-image-value'
    await EXECUTORS['ocr']!({ source: 'variable', imageVariable: 'shot' }, ctx)

    expect(ocrMock).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('error', expect.stringContaining('base64'))
  })

  it('an explicit lang overrides the global setting', async () => {
    chromeRefs.captureVisibleTab.mockResolvedValue('data:image/png;base64,PAGE')
    const { ctx } = makeCtx()
    await EXECUTORS['ocr']!({ lang: 'chi_sim+eng' }, ctx)
    expect(ocrMock).toHaveBeenCalledWith(expect.any(String), 'chi_sim+eng')
  })

  it('the output variable name is editable and the value is always a string', async () => {
    chromeRefs.captureVisibleTab.mockResolvedValue('data:image/png;base64,PAGE')
    const { ctx } = makeCtx()
    await EXECUTORS['ocr']!({ variableName: 'captcha' }, ctx)
    expect(ctx.variables['captcha']).toBe('AB12')
    // No fixed-output guarantee: the default name is only used when unset.
    expect(ctx.variables['lastOcrText']).toBeUndefined()
  })

  it('an empty output variable name falls back to lastOcrText', async () => {
    chromeRefs.captureVisibleTab.mockResolvedValue('data:image/png;base64,PAGE')
    const { ctx } = makeCtx()
    await EXECUTORS['ocr']!({ variableName: '' }, ctx)
    expect(ctx.variables['lastOcrText']).toBe('AB12')
  })

  it('an empty read throws with diagnostics so the engine onError machinery (retry/fallback) applies', async () => {
    ocrMock.mockResolvedValue({ ok: true, text: '   ', confidence: 0 })
    const { ctx, emit } = makeCtx()
    await expect(EXECUTORS['ocr']!({}, ctx)).rejects.toThrow('未识别到文字')
    // The failure must not look like a success — but the input diagnostics
    // (source, image size, preprocess) DO get logged to aid investigation.
    expect(emit).not.toHaveBeenCalledWith('result', expect.anything())
    expect(emit).toHaveBeenCalledWith('info', expect.stringContaining('[识别输入]'))
  })

  it('a failed OCR run surfaces the driver error as a block error', async () => {
    ocrMock.mockResolvedValue({ ok: false, error: 'OCR failed' })
    const { ctx, emit } = makeCtx()
    await expect(EXECUTORS['ocr']!({}, ctx)).rejects.toThrow('OCR failed')
    expect(emit).not.toHaveBeenCalledWith('result', expect.anything())
  })

  it('a missing element selector errors without calling OCR', async () => {
    const { ctx, emit } = makeCtx()
    await EXECUTORS['ocr']!({ source: 'element', selector: '' }, ctx)
    expect(ocrMock).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('error', expect.stringContaining('选择器'))
  })
})

describe('ocr cropRectFor (visible-page crop math)', () => {
  it('scales the CSS-pixel rect by devicePixelRatio', () => {
    expect(cropRectFor({ x: 10, y: 20, w: 100, h: 40, dpr: 2 }, 1600, 900)).toEqual({
      x: 20,
      y: 40,
      w: 200,
      h: 80,
    })
  })

  it('clamps the crop to the captured image bounds', () => {
    // Element hangs off the right/bottom edge of the viewport image.
    expect(cropRectFor({ x: 790, y: 440, w: 100, h: 100, dpr: 1 }, 800, 500)).toEqual({
      x: 790,
      y: 440,
      w: 10,
      h: 60,
    })
  })

  it('returns null when the element lies entirely outside the viewport image', () => {
    expect(cropRectFor({ x: 2000, y: 20, w: 100, h: 40, dpr: 1 }, 800, 500)).toBeNull()
    expect(cropRectFor({ x: 10, y: 600, w: 100, h: 40, dpr: 1 }, 800, 500)).toBeNull()
  })
})