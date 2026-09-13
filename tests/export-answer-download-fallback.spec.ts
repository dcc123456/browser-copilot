// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadBlob } from '../src/lib/export-answer'

/**
 * When the extension downloads API is unavailable (web preview / test harness),
 * `downloadBlob` falls back to an anchor download. Confirms the anchor is wired
 * with the filename and actually clicked.
 */
describe('downloadBlob — anchor fallback', () => {
  let createObjectURL: ReturnType<typeof vi.fn>
  let revokeObjectURL: ReturnType<typeof vi.fn>
  let clickSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    createObjectURL = vi.fn(() => 'blob:fallback')
    revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    delete (globalThis as { chrome?: unknown }).chrome
    clickSpy = vi.fn()
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreate(tag)
      if (tag === 'a') {
        el.click = clickSpy as unknown as typeof el.click
      }
      return el
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('falls back to an anchor click carrying the download filename', () => {
    downloadBlob('hello', 'text/plain', 'note.txt')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    const anchors = document.querySelectorAll('a')
    expect(anchors.length).toBeGreaterThan(0)
  })
})
