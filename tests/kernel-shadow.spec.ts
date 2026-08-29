/**
 * Open shadow-DOM support in the in-page kernel.
 *
 * Elements inside an OPEN shadow root must be visible to snapshot, carry a
 * shadowHosts chain in their target specs, be re-resolvable by the target, and
 * be clickable; an element inside a CLOSED shadow root is unreachable in-page
 * (the driver routes it through chrome.debugger), so a cdp-shadow spec is
 * treated as not found by the kernel.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { JSDOM } from 'jsdom'
import { runOp } from '../src/inpage/kernel'
import type { Op, Target } from '../src/lib/ops'

let dom: JSDOM

function makePage(opts: { closed?: boolean } = {}): void {
  dom = new JSDOM(
    `<!DOCTYPE html><body>
      <button id="light-btn">Light</button>
      <xhs-publish-btn id="publish-host"></xhs-publish-btn>
    </body>`,
    { url: 'https://example.test/', pretendToBeVisual: true },
  )
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

  const host = dom.window.document.getElementById('publish-host') as HTMLElement
  const root = host.attachShadow({ mode: opts.closed ? 'closed' : 'open' })
  root.innerHTML = `
    <div class="publish-page-publish-btn">
      <button type="button" class="ce-btn white">暂存离开</button>
      <button type="button" class="ce-btn bg-red" aria-disabled="false">发布</button>
    </div>`
}

beforeEach(() => {
  makePage({ closed: false })
})

describe('kernel open shadow DOM', () => {
  it('snapshot sees interactive elements inside an open shadow root', () => {
    const result = runOp({ action: 'snapshot' } as Op)
    expect(result.ok).toBe(true)
    const names = (result.page?.elements ?? []).map((e) => e.name)
    expect(names).toContain('发布')
    expect(names).toContain('暂存离开')
    expect(names).toContain('Light')
  })

  it('target for a shadowed element carries a shadowHosts chain', () => {
    const result = runOp({ action: 'snapshot' } as Op)
    const publish = (result.page?.elements ?? []).find((e) => e.name === '发布')
    expect(publish).toBeTruthy()
    const chain = publish!.target.primary.shadowHosts
    expect(chain && chain.length >= 1).toBe(true)
    // The host step is a light-DOM selector for <xhs-publish-btn>.
    expect(chain!.join(' ')).toContain('xhs-publish-btn')
  })

  it('resolves a shadowed element via its snapshot target and clicks it', () => {
    const result = runOp({ action: 'snapshot' } as Op)
    const publish = (result.page?.elements ?? []).find((e) => e.name === '发布')
    expect(publish).toBeTruthy()

    let clicked = 0
    const host = dom.window.document.getElementById('publish-host') as HTMLElement
    const shadowBtn = host.shadowRoot!.querySelector('button.bg-red') as HTMLElement
    shadowBtn.addEventListener('click', () => { clicked += 1 })

    const clickResult = runOp({ action: 'click', target: publish!.target } as Op)
    expect(clickResult.ok).toBe(true)
    expect(clicked).toBe(1)
  })

  it('wait_for finds a shadowed element through its target', () => {
    const result = runOp({ action: 'snapshot' } as Op)
    const publish = (result.page?.elements ?? []).find((e) => e.name === '发布')
    const wait = runOp({ action: 'wait_for', target: publish!.target } as Op)
    expect(wait.ok).toBe(true)
    expect(wait.found).toBe(true)
  })

  it('treats a cdp-shadow (closed) spec as unresolvable in-page', () => {
    const target: Target = {
      primary: { how: 'cdp-shadow', value: '发布', role: 'button', tag: 'button', closedShadow: true },
      fallbacks: [],
    }
    const result = runOp({ action: 'click', target } as Op)
    expect(result.found).toBe(false)
  })

  it('closed shadow root elements are NOT visible to in-page snapshot', () => {
    makePage({ closed: true })
    const result = runOp({ action: 'snapshot' } as Op)
    const names = (result.page?.elements ?? []).map((e) => e.name)
    expect(names).not.toContain('发布')
    expect(names).toContain('Light')
  })
})
