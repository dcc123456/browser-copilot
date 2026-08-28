/**
 * Selector generation: id / class / tag+nth-of-type options, ancestor
 * disambiguation, XPath generation, and match counting.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { JSDOM } from 'jsdom'
import {
  buildSelector,
  buildXPath,
  countMatches,
  queryMatches,
  DEFAULT_SELECTOR_OPTIONS,
  type SelectorOptions,
} from '../src/inpage/element-picker/build-selector'

let doc: Document
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let win: any

beforeEach(() => {
  const dom = new JSDOM(
    `<!DOCTYPE html><body>
      <div id="app">
        <header><nav><a class="nav-link home" href="/">Home</a><a class="nav-link" href="/x">X</a></nav></header>
        <main>
          <button data-testid="submit" class="btn primary">Go</button>
          <ul class="items">
            <li>one</li>
            <li>two</li>
            <li class="special">three</li>
          </ul>
          <form>
            <input name="email" type="email" />
            <input name="q" type="search" data-test="qfield" />
          </form>
        </main>
      </div>
    </body>`,
    { url: 'https://example.test/' },
  )
  win = dom.window
  doc = dom.window.document
  // Provide CSS.escape for the module (jsdom supports it on its own window).
  ;(globalThis as { CSS?: unknown }).CSS = (win as unknown as { CSS: typeof CSS }).CSS
})

const opts = (over: Partial<SelectorOptions> = {}): SelectorOptions => ({
  ...DEFAULT_SELECTOR_OPTIONS,
  ...over,
})

describe('buildSelector', () => {
  it('uses a unique id', () => {
    const el = doc.getElementById('app')!
    const sel = buildSelector(el, doc)
    expect(sel).toBe('#app')
    expect(doc.querySelectorAll(sel)).toHaveLength(1)
  })

  it('uses data-testid when attr options are enabled', () => {
    const el = doc.querySelector('[data-testid="submit"]')!
    const sel = buildSelector(el, doc, opts({ idName: false, className: false, attr: true }))
    expect(sel).toContain('[data-testid="submit"]')
    expect(doc.querySelectorAll(sel)).toHaveLength(1)
  })

  it('uses a distinctive class and disambiguates to a unique match', () => {
    const el = doc.querySelector('li.special')!
    const sel = buildSelector(el, doc, opts({ idName: false }))
    expect(sel).toContain('.special')
    expect(doc.querySelectorAll(sel)).toHaveLength(1)
    expect(doc.querySelectorAll(sel)[0]).toBe(el)
  })

  it('falls back to tag + nth-of-type when no id/class/attr', () => {
    const el = doc.querySelectorAll('li')[0]!
    const sel = buildSelector(el, doc, opts({ idName: false, className: false, attr: false }))
    expect(doc.querySelectorAll(sel)).toHaveLength(1)
    expect(doc.querySelectorAll(sel)[0]).toBe(el)
  })

  it('walks ancestors until unique for repeated tags', () => {
    const el = doc.querySelectorAll('li')[1]!
    const sel = buildSelector(el, doc, opts({ idName: false, className: false, attr: false }))
    expect(doc.querySelectorAll(sel)).toHaveLength(1)
    expect(doc.querySelectorAll(sel)[0]).toBe(el)
  })

  it('selector matches the exact element not just any element', () => {
    const el = doc.querySelector('input[name="q"]')!
    const sel = buildSelector(el, doc)
    const found = doc.querySelectorAll(sel)
    expect(found).toHaveLength(1)
    expect(found[0]).toBe(el)
  })
})

describe('buildXPath', () => {
  it('uses id when present', () => {
    expect(buildXPath(doc.getElementById('app')!)).toContain('@id="app"')
  })

  it('generates indexed path for repeated siblings', () => {
    const el = doc.querySelectorAll('li')[2]!
    const xp = buildXPath(el)
    const result = doc.evaluate(
      xp,
      doc,
      null,
      (win as unknown as { XPathResult: typeof XPathResult }).XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    )
    expect(result.snapshotLength).toBe(1)
  })
})

describe('countMatches', () => {
  it('counts css matches', () => {
    expect(countMatches('li', 'cssSelector', doc)).toBe(3)
    expect(countMatches('.nav-link', 'cssSelector', doc)).toBe(2)
  })

  it('counts xpath matches', () => {
    expect(countMatches('//body//li', 'xpath', doc)).toBe(3)
    expect(countMatches('//a', 'xpath', doc)).toBe(2)
  })

  it('returns 0 for invalid selectors instead of throwing', () => {
    expect(countMatches('!!!', 'cssSelector', doc)).toBe(0)
  })
})

describe('queryMatches', () => {
  it('resolves elements for css and xpath', () => {
    expect(queryMatches('button', 'cssSelector', doc)).toHaveLength(1)
    expect(queryMatches('//body//a', 'xpath', doc)).toHaveLength(2)
  })
})
