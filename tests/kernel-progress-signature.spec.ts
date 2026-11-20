/**
 * `progress_signature`: the result-based progress digest (spec R1).
 *
 * The contract that matters is what must NOT move it — scrolling without new
 * content, a password value — and what must move it: text, control values,
 * navigation. A digest that changes on scroll would give "scroll to the bottom
 * forever" a free pass, which is exactly the C3 failure.
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

function signature(): string {
  const result = runOp({ action: 'progress_signature' })
  expect(result.ok).toBe(true)
  return String(result.data)
}

describe('kernel progress_signature', () => {
  beforeEach(() => {
    boot(`<body>
      <p id="t">Price: 10 yuan</p>
      <button id="buy">Buy now</button>
      <input id="qty" value="1" />
      <input id="pw" type="password" value="hunter2" />
    </body>`)
  })

  it('is stable when nothing changes', () => {
    expect(signature()).toBe(signature())
  })

  it('changes when visible text changes', () => {
    const before = signature()
    dom.window.document.getElementById('t')!.textContent = 'Price: 20 yuan'
    expect(signature()).not.toBe(before)
  })

  it('changes when a control value changes', () => {
    const before = signature()
    ;(dom.window.document.getElementById('qty') as HTMLInputElement).value = '2'
    expect(signature()).not.toBe(before)
  })

  it('does NOT change when only the scroll position moves', () => {
    const before = signature()
    dom.window.scrollTo(0, 500)
    expect(signature()).toBe(before)
  })

  it('does not expose the password value and does not move when it changes', () => {
    const before = signature()
    ;(dom.window.document.getElementById('pw') as HTMLInputElement).value = 'another-secret'
    const after = signature()
    expect(after).toBe(before)
    expect(after).not.toContain('hunter2')
    expect(after).not.toContain('another-secret')
  })

  it('changes when the URL changes', () => {
    const before = signature()
    dom.reconfigure({ url: 'https://example.test/next' })
    expect(signature()).not.toBe(before)
  })
})
