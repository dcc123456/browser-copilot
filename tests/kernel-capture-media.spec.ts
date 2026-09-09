/**
 * Media-aware element capture in the in-page kernel (runOp `capture` op).
 *
 * A `<canvas>`'s bitmap is not part of the DOM serialization and an SVG loaded
 * as an image loads no external resources — so a canvas-drawn captcha, or a
 * text-less container wrapping one / an <img>, used to serialize into a
 * valid-looking PNG with NO glyphs. The kernel must pull the REAL pixels:
 * canvas → toDataURL, container → its largest media child (img src / canvas /
 * blob inline). A container with actual text content keeps the SVG path.
 *
 * The `capture` op returns a Promise (chrome.scripting.executeScript awaits
 * it), so every assertion here awaits runOp's result.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { runOp } from '../src/inpage/kernel'
import type { Op } from '../src/lib/ops'

let dom: JSDOM

/** An Image that "loads" any src on the next microtask (SVG fallback path). */
class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 158
  naturalHeight = 67
  set src(_v: string) {
    queueMicrotask(() => this.onload?.())
  }
}

function makePage(bodyHtml: string): void {
  dom = new JSDOM(`<!DOCTYPE html><body>${bodyHtml}</body>`, {
    url: 'https://checkin.example.test/',
    pretendToBeVisual: true,
  })
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.self = dom.window
  g.top = dom.window
  g.document = dom.window.document
  g.location = dom.window.location
  g.HTMLElement = dom.window.HTMLElement
  g.HTMLInputElement = dom.window.HTMLInputElement
  g.HTMLImageElement = dom.window.HTMLImageElement
  g.HTMLCanvasElement = dom.window.HTMLCanvasElement
  g.SVGElement = dom.window.SVGElement
  g.ShadowRoot = dom.window.ShadowRoot
  g.DocumentFragment = dom.window.DocumentFragment
  g.Node = dom.window.Node
  g.Element = dom.window.Element
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
  // jsdom's un-implemented canvas raster returns null; a generic data URL
  // lets the SVG fallback path complete so tests can distinguish paths.
  // (Per-element overrides in each test shadow this prototype default.)
  const proto = dom.window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>
  proto.toDataURL = () => 'data:image/png;base64,SVGFALLBACK'
  // jsdom has no canvas rasterizer: a minimal 2d context keeps the SVG
  // fallback path (fillRect + drawImage + toDataURL) completing.
  proto.getContext = () =>
    ({
      fillStyle: '',
      fillRect: () => {},
      drawImage: () => {},
    }) as unknown as CanvasRenderingContext2D
  // kernel references bare XMLSerializer/Image in the SVG path.
  vi.stubGlobal('XMLSerializer', dom.window.XMLSerializer)
  vi.stubGlobal('Image', FakeImage as unknown as typeof Image)
}

/** jsdom does no layout: every element reports a 0x0 rect. Stub per element. */
function show(el: Element, w: number, h: number): void {
  el.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: w, height: h, top: 0, left: 0, right: w, bottom: h }) as DOMRect
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('kernel capture: media elements resolve to real pixels', () => {
  it('a canvas host resolves to its own toDataURL pixels', async () => {
    makePage('<div id="box"><canvas id="cv"></canvas></div>')
    const canvas = dom.window.document.getElementById('cv')!
    show(canvas, 158, 67)
    ;(canvas as unknown as { toDataURL: () => string }).toDataURL = () =>
      'data:image/png;base64,CANVASPIX'
    const result = await runOp({ action: 'capture', value: '#cv' } as Op)
    expect(result.ok).toBe(true)
    expect(result.note).toBe('captured-canvas')
    expect(result.data).toBe('data:image/png;base64,CANVASPIX')
  })

  it('a text-less container resolves to its canvas child pixels', async () => {
    makePage('<div id="box"><canvas id="cv"></canvas></div>')
    const canvas = dom.window.document.getElementById('cv')!
    show(canvas, 158, 67)
    ;(canvas as unknown as { toDataURL: () => string }).toDataURL = () =>
      'data:image/png;base64,BOXCANVAS'
    const result = await runOp({ action: 'capture', value: '#box' } as Op)
    expect(result.ok).toBe(true)
    expect(result.note).toBe('captured-canvas')
    expect(result.data).toBe('data:image/png;base64,BOXCANVAS')
  })

  it('a text-less container resolves to its img child source URL', async () => {
    makePage('<div id="box"><img id="cap" src="/captcha.png"></div>')
    show(dom.window.document.getElementById('box')!, 158, 67)
    show(dom.window.document.getElementById('cap')!, 150, 60)
    const result = await runOp({ action: 'capture', value: '#box' } as Op)
    expect(result.ok).toBe(true)
    expect(result.note).toBe('captured-img-src')
    expect(result.data).toBe('https://checkin.example.test/captcha.png')
  })

  it('an img with a blob: src is inlined to a data URL by the page', async () => {
    makePage('<div id="box"><img id="cap" src="blob:https://checkin.example.test/uuid"></div>')
    show(dom.window.document.getElementById('box')!, 158, 67)
    show(dom.window.document.getElementById('cap')!, 150, 60)
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ blob: async () => new dom.window.Blob([bytes], { type: 'image/png' }) })),
    )
    vi.stubGlobal('FileReader', dom.window.FileReader)
    const result = await runOp({ action: 'capture', value: '#box' } as Op)
    expect(result.ok).toBe(true)
    expect(result.note).toBe('captured-img-src')
    expect(String(result.data).startsWith('data:image/png;base64,')).toBe(true)
  })

  it('a tainted canvas (toDataURL throws) does not become the capture result', async () => {
    makePage('<div id="box"><canvas id="cv"></canvas></div>')
    const canvas = dom.window.document.getElementById('cv')!
    show(canvas, 158, 67)
    ;(canvas as unknown as { toDataURL: () => string }).toDataURL = () => {
      throw new Error('tainted')
    }
    const result = await runOp({ action: 'capture', value: '#box' } as Op)
    // Falls through to the SVG path (FakeImage + fallback raster above), so
    // the media capture is NOT reported.
    expect(result.note).not.toBe('captured-canvas')
  })

  it('a container WITH text content keeps the SVG path (no media capture)', async () => {
    makePage('<div id="box">Hello <canvas id="cv"></canvas></div>')
    show(dom.window.document.getElementById('box')!, 300, 100)
    show(dom.window.document.getElementById('cv')!, 158, 67)
    const result = await runOp({ action: 'capture', value: '#box' } as Op)
    expect(result.ok).toBe(true)
    expect(result.note).toBe('captured')
    expect(result.data).toBe('data:image/png;base64,SVGFALLBACK')
  })

  it('zero-size (hidden) media children are ignored', async () => {
    makePage('<div id="box"><canvas id="hidden-cv"></canvas></div>')
    show(dom.window.document.getElementById('box')!, 158, 67)
    // No rect stub on the canvas → jsdom reports 0x0 → not capturable media.
    const result = await runOp({ action: 'capture', value: '#box' } as Op)
    expect(result.note).not.toBe('captured-canvas')
  })
})
