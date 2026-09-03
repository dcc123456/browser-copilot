import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `captureVisiblePage` must never collapse a failed `captureVisibleTab` into
 * an opaque null: the caller (and the model reading the tool result) needs the
 * underlying Chrome error plus an actionable hint. It must also repair the two
 * recoverable cases itself — a minimized window (restore, then capture) and a
 * transient race (one retry) — and refuse browser-internal pages up front with
 * the reason instead of Chrome's generic rejection.
 */
function makeChromeMock(overrides?: {
  tab?: Partial<chrome.tabs.Tab> | null
  windowState?: string
}): {
  captureVisibleTab: ReturnType<typeof vi.fn>
  windowsGet: ReturnType<typeof vi.fn>
  windowsUpdate: ReturnType<typeof vi.fn>
  query: ReturnType<typeof vi.fn>
} {
  const tab = {
    id: 7,
    windowId: 3,
    url: 'https://example.com/',
    title: 'Example',
    active: true,
    ...overrides?.tab,
  } as chrome.tabs.Tab
  const query = vi.fn(async () => (overrides?.tab === null ? [] : [tab]))
  const captureVisibleTab = vi.fn(async () => 'data:image/png;base64,SHOT')
  const windowsGet = vi.fn(async () => ({ id: 3, state: overrides?.windowState ?? 'normal' }))
  const windowsUpdate = vi.fn(async () => ({ id: 3 }))
  vi.stubGlobal(
    'chrome',
    {
      tabs: { query, captureVisibleTab },
      windows: { get: windowsGet, update: windowsUpdate },
    } as unknown as typeof chrome,
  )
  return { captureVisibleTab, windowsGet, windowsUpdate, query }
}

import { captureVisiblePage } from '../src/background/capture'

describe('captureVisiblePage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('captures the active tab and reports the data url', async () => {
    const refs = makeChromeMock()
    const result = await captureVisiblePage()

    expect(result).toEqual({ ok: true, dataUrl: 'data:image/png;base64,SHOT' })
    expect(refs.captureVisibleTab).toHaveBeenCalledWith(3, { format: 'png' })
  })

  it('passes jpeg quality through to the capture options', async () => {
    const refs = makeChromeMock()
    await captureVisiblePage(undefined, { format: 'jpeg', quality: 60 })

    expect(refs.captureVisibleTab).toHaveBeenCalledWith(3, { format: 'jpeg', quality: 60 })
  })

  it('reports a clear error when no tab is active', async () => {
    const refs = makeChromeMock({ tab: null })
    const result = await captureVisiblePage()

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('No active tab')
    expect(refs.captureVisibleTab).not.toHaveBeenCalled()
  })

  it('refuses browser-internal pages up front with the reason', async () => {
    const refs = makeChromeMock({ tab: { url: 'chrome://new-tab-page/' } })
    const result = await captureVisiblePage()

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('chrome://new-tab-page/')
    expect(result.ok ? '' : result.error).toContain('off limits')
    expect(refs.captureVisibleTab).not.toHaveBeenCalled()
  })

  it('restores a minimized window before capturing', async () => {
    const refs = makeChromeMock({ windowState: 'minimized' })
    const result = await captureVisiblePage()

    expect(refs.windowsUpdate).toHaveBeenCalledWith(3, { state: 'normal', focused: true })
    expect(result).toEqual({ ok: true, dataUrl: 'data:image/png;base64,SHOT' })
  })

  it('retries once on a transient failure and succeeds', async () => {
    const refs = makeChromeMock()
    refs.captureVisibleTab
      .mockRejectedValueOnce(new Error('The tab was still loading'))
      .mockResolvedValueOnce('data:image/png;base64,RETRY')
    const result = await captureVisiblePage()

    expect(refs.captureVisibleTab).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ ok: true, dataUrl: 'data:image/png;base64,RETRY' })
  })

  it('surfaces the raw Chrome error plus a hint after the retry fails', async () => {
    const refs = makeChromeMock()
    refs.captureVisibleTab.mockRejectedValue(
      new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.'),
    )
    const result = await captureVisiblePage()

    expect(result.ok).toBe(false)
    const error = result.ok ? '' : result.error
    expect(error).toContain('Screenshot failed')
    expect(error).toContain('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')
    expect(error).toContain('quota')
  })

  it('maps the missing <all_urls> permission error to the manifest hint, not the page-type hint', async () => {
    // Specific host patterns in host_permissions trigger exactly this Chrome
    // rejection on ordinary http(s) pages — the hint must point at the
    // manifest, not tell the user to switch pages.
    const refs = makeChromeMock()
    refs.captureVisibleTab.mockRejectedValue(
      new Error("Either the '<all_urls>' or 'activeTab' permission is required."),
    )
    const result = await captureVisiblePage()

    expect(result.ok).toBe(false)
    const error = result.ok ? '' : result.error
    expect(error).toContain("'<all_urls>' host permission")
    expect(error).not.toContain('page type')
  })
})
