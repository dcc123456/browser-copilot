// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadAnswer, downloadBlob } from '../src/lib/export-answer'

/**
 * Covers the extension download path: `downloadBlob` must route through
 * `chrome.downloads.download` (reliable from the side panel) instead of the
 * anchor trick, and must NOT bail when `document` is missing just because the
 * downloads API is available. This is the regression test for the
 * "点击下载无反应" report.
 */
describe('downloadBlob — extension downloads API path', () => {
  let createObjectURL: ReturnType<typeof vi.fn>
  let revokeObjectURL: ReturnType<typeof vi.fn>
  let download: ReturnType<typeof vi.fn>

  beforeEach(() => {
    createObjectURL = vi.fn(() => 'blob:test-url')
    revokeObjectURL = vi.fn()
    download = vi.fn(() => Promise.resolve(7))
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    ;(globalThis as { chrome?: unknown }).chrome = { downloads: { download } }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (globalThis as { chrome?: unknown }).chrome
  })

  it('routes an answer download through chrome.downloads.download', () => {
    downloadAnswer({ text: '# Title\n\nbody', format: 'md', title: '我的对话' })
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledTimes(1)
    const arg = download.mock.calls[0]![0]
    expect(arg.url).toBe('blob:test-url')
    expect(arg.filename).toMatch(/我的对话.*\.md$/)
    expect(arg.conflictAction).toBe('uniquify')
    expect(arg.saveAs).toBe(false)
    // The blob URL is revoked lazily (after the transfer starts), so a click no
    // longer silently aborts the download.
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('does not bail when document is absent but the downloads API exists', () => {
    expect(download).not.toHaveBeenCalled()
    downloadBlob('x', 'text/plain', 'a.txt')
    expect(download).toHaveBeenCalledTimes(1)
    expect(download.mock.calls[0]![0].filename).toBe('a.txt')
  })
})
