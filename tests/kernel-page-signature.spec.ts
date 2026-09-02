/**
 * The `page_signature` op: the driver's quiescence probe. Two identical
 * consecutive signatures mean "the page has settled" — an auto-observation is
 * only captured after that, so it reflects post-action state, not the
 * pre-render snapshot.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { JSDOM } from 'jsdom'
import { runOp } from '../src/inpage/kernel'

let dom: JSDOM

function boot(html: string, url = 'https://example.test/'): void {
  dom = new JSDOM(html, { url, pretendToBeVisual: true })
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.self = dom.window
  g.top = dom.window
  g.document = dom.window.document
  g.location = dom.window.location
}

describe('kernel page_signature', () => {
  beforeEach(() => {
    boot('<body><p id="t">Hello</p></body>')
  })

  it('returns ok with a string signature', () => {
    const result = runOp({ action: 'page_signature' })
    expect(result.ok).toBe(true)
    expect(typeof result.data).toBe('string')
    expect(result.data).toContain('https://example.test/')
  })

  it('changes when the DOM changes, stays equal when it does not', () => {
    const before = runOp({ action: 'page_signature' }).data as string
    const doc = dom.window.document
    doc.getElementById('t')!.textContent = 'Hello world, updated'
    const after = runOp({ action: 'page_signature' }).data as string
    expect(after).not.toBe(before)
    // No mutation → identical signature → the driver treats the page as settled.
    expect(runOp({ action: 'page_signature' }).data).toBe(after)
  })
})
