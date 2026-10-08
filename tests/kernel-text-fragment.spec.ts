/**
 * Text-locator fragment resolution.
 *
 * Round 68 replayed 19/19 steps and really saved the draft, and the only unmet
 * row was its own goal condition «文本包含 "草稿"» — the page shows 「草稿箱(100)」,
 * and a `text` spec used to be EXACT-only, so a word the model abbreviated could
 * never be observed. The fallback runs only when the exact pass found nothing, and
 * it still returns the tightest element, so it cannot re-point a spec that already
 * resolved and cannot answer with a page-wide container.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { JSDOM } from 'jsdom'
import { runOp } from '../src/inpage/kernel'
import type { Op, Target } from '../src/lib/ops'

function makePage(html: string): void {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`, {
    url: 'https://example.test/page',
  })
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.self = dom.window
  g.top = dom.window
  g.document = dom.window.document
  g.location = dom.window.location
  g.HTMLElement = dom.window.HTMLElement
  g.Node = dom.window.Node
  g.Element = dom.window.Element
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
}

function countTarget(value: string): number {
  const target = { primary: { how: 'text', value }, fallbacks: [] } as unknown as Target
  const result = runOp({ action: 'count_elements', target } as unknown as Op)
  return Number(result.data)
}

describe('a text spec whose word is a fragment of what the page says', () => {
  beforeEach(() => {
    makePage(`
      <div class="menu">
        <span>草稿箱(100)</span>
        <span>发布笔记</span>
      </div>
    `)
  })

  it('resolves through the contains fallback when nothing matches exactly', () => {
    expect(countTarget('草稿箱(100)')).toBe(1)
    expect(countTarget('草稿')).toBe(1)
  })

  it('prefers the tightest element, not the container that holds it', () => {
    makePage('<div><section><span>草稿箱(100)</span></section></div>')
    expect(countTarget('草稿')).toBe(1)
  })

  it('never widens a word that already has an exact match', () => {
    makePage('<span>草稿</span><span>草稿箱(100)</span>')
    expect(countTarget('草稿')).toBe(1)
  })
})
