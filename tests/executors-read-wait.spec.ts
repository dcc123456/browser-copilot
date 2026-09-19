/**
 * Read blocks wait for the element to render.
 *
 * Reads (`get-text` / `attribute-value` / `read-page`) used to be single-shot:
 * one `querySelectorAll`, and an empty result failed the step. That was fine
 * while a human paced the generation session, but a REPLAY runs back-to-back —
 * a read right after a click-triggered navigation raced the page's own
 * rendering and failed with "没有读到任何内容" before the element existed.
 *
 * `pollRead` retries an empty read until content shows up or the window
 * expires. These tests pin the three behaviors a future change is most likely
 * to break silently: the retry itself, the opt-out, and the window expiry
 * still failing with the caller's original error text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_READ_WAIT_MS,
  EXECUTORS,
  readWaitMsOf,
  type WorkflowExecCtx,
} from '../src/background/workflow-engine/executors'

vi.mock('../src/background/driver', async (importActual) => {
  const actual = await importActual<typeof import('../src/background/driver')>()
  return { ...actual, execOnActiveTab: vi.fn() }
})

import { execOnActiveTab } from '../src/background/driver'

function makeChromeMock() {
  const tab = { id: 1, windowId: 1, url: 'https://example.com/', active: true }
  const executeScript = vi.fn<
    (details: { target: { tabId: number }; args?: unknown[] }) => Promise<unknown[]>
  >(async () => [{ result: ['late text'] as unknown }])
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
    tab,
  }
}

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

let chromeRefs: ReturnType<typeof makeChromeMock>

beforeEach(() => {
  chromeRefs = makeChromeMock()
  vi.stubGlobal('chrome', chromeRefs.chrome)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('readWaitMsOf', () => {
  it('defaults to the read window', () => {
    expect(readWaitMsOf({})).toBe(DEFAULT_READ_WAIT_MS)
    expect(readWaitMsOf({ waitForSelector: true })).toBe(DEFAULT_READ_WAIT_MS)
  })

  it('honors an explicit positive window and the opt-out', () => {
    expect(readWaitMsOf({ waitSelectorTimeout: 250 })).toBe(250)
    expect(readWaitMsOf({ waitForSelector: false })).toBe(0)
    expect(readWaitMsOf({ waitForSelector: false, waitSelectorTimeout: 250 })).toBe(0)
    // A non-numeric / non-positive timeout falls back to the default.
    expect(readWaitMsOf({ waitSelectorTimeout: 'abc' })).toBe(DEFAULT_READ_WAIT_MS)
    expect(readWaitMsOf({ waitSelectorTimeout: 0 })).toBe(DEFAULT_READ_WAIT_MS)
  })
})

describe('get-text polling', () => {
  it('retries an empty read until the element renders', async () => {
    // First injection races the (simulated) render; the second sees content.
    chromeRefs.executeScript
      .mockResolvedValueOnce([{ result: [] }])
      .mockResolvedValueOnce([{ result: ['late text'] }])

    const { ctx } = makeCtx()
    await EXECUTORS['get-text']!({ selector: '.late', waitSelectorTimeout: 1000 }, ctx)

    expect(chromeRefs.executeScript.mock.calls.length).toBe(2)
    expect(ctx.variables['lastText']).toBe('late text')
  })

  it('keeps the single-shot behavior when the node opts out', async () => {
    chromeRefs.executeScript.mockResolvedValue([{ result: [] }])
    const { ctx } = makeCtx()

    await expect(
      EXECUTORS['get-text']!({ selector: '.gone', waitForSelector: false }, ctx),
    ).rejects.toThrow(/\.gone/)

    expect(chromeRefs.executeScript).toHaveBeenCalledTimes(1)
  })

  it('still fails with the original error once the window expires', async () => {
    chromeRefs.executeScript.mockResolvedValue([{ result: [] }])
    const { ctx } = makeCtx()

    await expect(
      EXECUTORS['get-text']!({ selector: '.never', waitSelectorTimeout: 50 }, ctx),
    ).rejects.toThrow(/\.never/)

    // More than one attempt was made before giving up.
    expect(chromeRefs.executeScript.mock.calls.length).toBeGreaterThan(1)
    expect(ctx.variables['lastText']).toBeUndefined()
  })
})

describe('attribute-value polling', () => {
  it('hands its poll window to the kernel via op.waitFor', async () => {
    vi.mocked(execOnActiveTab).mockResolvedValue({
      ok: true,
      found: true,
      frameUrl: '',
      isTopFrame: true,
      data: 'attrValue',
    })
    const { ctx } = makeCtx()

    await EXECUTORS['attribute-value']!(
      { selector: '.late', attribute: 'href', waitSelectorTimeout: 750 },
      ctx,
    )

    const [op] = vi.mocked(execOnActiveTab).mock.calls[0]!
    expect(op.waitFor).toBe(750)
    expect(ctx.variables['lastAttribute']).toBe('attrValue')
  })

  it('sends no wait when the node opts out', async () => {
    vi.mocked(execOnActiveTab).mockResolvedValue({
      ok: true,
      found: true,
      frameUrl: '',
      isTopFrame: true,
      data: 'attrValue',
    })
    const { ctx } = makeCtx()

    await EXECUTORS['attribute-value']!(
      { selector: '.now', attribute: 'href', waitForSelector: false },
      ctx,
    )

    const [op] = vi.mocked(execOnActiveTab).mock.calls[0]!
    expect(op.waitFor).toBeUndefined()
  })
})

describe('read-page polling', () => {
  it('retries an element-scoped text read until content appears', async () => {
    chromeRefs.executeScript
      .mockResolvedValueOnce([{ result: [] }])
      .mockResolvedValueOnce([{ result: ['scoped'] }])

    const { ctx } = makeCtx()
    await EXECUTORS['read-page']!({ selector: '.article', waitSelectorTimeout: 1000 }, ctx)

    expect(chromeRefs.executeScript.mock.calls.length).toBe(2)
    expect(ctx.variables['lastReadPage']).toBe('scoped')
  })

  it('retries a whole-page text read whose body has not rendered', async () => {
    vi.mocked(execOnActiveTab).mockResolvedValue({
      ok: true,
      found: true,
      frameUrl: '',
      isTopFrame: true,
    })
    chromeRefs.executeScript
      .mockResolvedValueOnce([
        { result: { url: 'https://example.com/', title: 'Example', selection: '', raw: '   ' } },
      ])
      .mockResolvedValueOnce([
        {
          result: { url: 'https://example.com/', title: 'Example', selection: '', raw: 'body' },
        },
      ])

    const { ctx } = makeCtx()
    await EXECUTORS['read-page']!({ waitSelectorTimeout: 1000 }, ctx)

    expect(ctx.variables['lastReadPage']).toBe('body')
  })
})
