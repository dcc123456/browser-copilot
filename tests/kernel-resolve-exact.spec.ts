/**
 * Exact-match-preferring target resolution (kernel).
 *
 * `resolve()` used to take the FIRST candidate spec that matched ANY element.
 * Recorded locators lead with a CSS spec because it is the most CSS-mappable —
 * usually a positional path — and a positional path that outlives a layout
 * change still matches, just the WRONG element. The first click then lands in
 * silence on something else.
 *
 * Resolution is now two-tier: a spec matching EXACTLY ONE element wins over an
 * earlier multi-match; the first multi-match is kept as the fallback so the
 * legacy "first visible of many" behavior survives for targets with no exact
 * spec at all.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { JSDOM } from 'jsdom'
import { runOp } from '../src/inpage/kernel'
import type { Op, OpResult, Target } from '../src/lib/ops'

let dom: JSDOM

function makePage(html: string): void {
  dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`, {
    url: 'https://example.test/page',
  })
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.self = dom.window
  g.top = dom.window
  g.document = dom.window.document
  g.location = dom.window.location
  g.HTMLElement = dom.window.HTMLElement
  g.HTMLInputElement = dom.window.HTMLInputElement
  g.HTMLButtonElement = dom.window.HTMLButtonElement
  g.HTMLAnchorElement = dom.window.HTMLAnchorElement
  g.HTMLSelectElement = dom.window.HTMLSelectElement
  g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  g.HTMLFormElement = dom.window.HTMLElement
  g.ShadowRoot = dom.window.ShadowRoot
  g.DocumentFragment = dom.window.DocumentFragment
  g.MouseEvent = dom.window.MouseEvent
  g.PointerEvent = dom.window.PointerEvent
  g.Event = dom.window.Event
  g.Node = dom.window.Node
  g.Element = dom.window.Element
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
}

function clickOp(target: Target): Op {
  return { action: 'click', target }
}

describe('kernel resolve: exact match preferred', () => {
  beforeEach(() => {
    // Three cards in a list; the middle one carries the stable id.
    makePage(`
      <div class="list">
        <div class="card"><button> buy </button></div>
        <div class="card" id="target-card"><button> buy </button></div>
        <div class="card"><button> buy </button></div>
      </div>
    `)
  })

  it('skips a multi-match positional primary when a fallback matches exactly one', () => {
    const target: Target = {
      // What a recorded locator looks like after a layout change: the
      // positional path degraded to its class part and now matches all
      // three cards…
      primary: { how: 'css', value: '.list > div' },
      // …while the id recorded as a fallback still names the picked one.
      fallbacks: [{ how: 'id', value: 'target-card' }],
    }
    const result = runOp(clickOp(target)) as OpResult

    expect(result.ok).toBe(true)
    expect(result.found).toBe(true)
    // The exact spec, not the loose primary, produced the resolution.
    expect(result.usedSpec).toContain('target-card')
    expect(result.matched).toBe(1)
  })

  it('keeps the loose first-match behavior when nothing matches exactly', () => {
    const target: Target = {
      primary: { how: 'css', value: '.card' },
      fallbacks: [],
    }
    const result = runOp(clickOp(target)) as OpResult

    expect(result.ok).toBe(true)
    expect(result.matched).toBe(3)
    expect(result.usedSpec).toContain('.card')
  })

  it('prefers an exact fallback over a multi-match primary with the same selector shape', () => {
    makePage(`
      <ul>
        <li data-testid="item-a">a</li>
        <li data-testid="item-b">b</li>
      </ul>
      <p id="solo">solo</p>
    `)
    const target: Target = {
      primary: { how: 'css', value: 'li' },
      fallbacks: [{ how: 'id', value: 'solo' }],
    }
    const result = runOp(clickOp(target)) as OpResult

    expect(result.ok).toBe(true)
    expect(result.matched).toBe(1)
    expect(result.usedSpec).toContain('solo')
  })
})
