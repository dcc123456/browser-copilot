// @vitest-environment jsdom
/**
 * The loop-folding probe, against a REAL DOM.
 *
 * `deriveLoopSelectorInPage` is the highest-risk piece of the folding feature:
 * it is injected into a live page, it is the only thing standing between a
 * varying run and a loop that iterates the wrong elements, and it cannot be
 * reasoned about from the recorded selectors alone. Stubbing `querySelectorAll`
 * would only re-assert the algorithm's own assumptions, so these tests run the
 * real function against real jsdom fixtures.
 *
 * The contract under test: the returned selector must match EXACTLY the
 * recorded elements, in the recorded order — `loop-elements` hands iteration N
 * the N-th match, so a candidate that is merely "close" is a wrong workflow.
 * Every refusal asserted here is a case where returning something would have
 * been worse than returning null.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCollapseProbe, deriveLoopSelectorInPage } from '../src/background/collapse-probe'
import type { ScopeWindow } from '../src/background/automation-scope'

function setBody(html: string): void {
  document.body.innerHTML = html
}

function selectorsFor(...css: string[]): string[] {
  return css
}

afterEach(() => {
  setBody('')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('deriveLoopSelectorInPage — refusals with nothing to fold', () => {
  it('refuses fewer than two selectors', () => {
    setBody('<div id="a"></div>')
    expect(deriveLoopSelectorInPage([])).toBeNull()
    expect(deriveLoopSelectorInPage(['#a'])).toBeNull()
  })

  it('refuses when a selector matches nothing', () => {
    setBody('<div id="a"></div>')
    expect(deriveLoopSelectorInPage(selectorsFor('#a', '#missing'))).toBeNull()
  })

  it('refuses when the same element was recorded twice', () => {
    // Not a per-element run: folding it would loop over one element forever.
    setBody('<div id="dup"></div>')
    expect(deriveLoopSelectorInPage(selectorsFor('#dup', '#dup'))).toBeNull()
  })

  it('refuses an unparsable selector instead of throwing', () => {
    setBody('<div id="a"></div><div id="b"></div>')
    expect(deriveLoopSelectorInPage(selectorsFor('#a', '###'))).toBeNull()
  })

  it('refuses a run whose elements are not all the same tag', () => {
    setBody('<div id="a"></div><span id="b"></span>')
    expect(deriveLoopSelectorInPage(selectorsFor('#a', '#b'))).toBeNull()
  })
})

describe('deriveLoopSelectorInPage — candidate 1: stripped positional paths', () => {
  it('returns the shared path when stripping the positions matches exactly the run', () => {
    setBody(`
      <div class="list">
        <div class="item"><span class="price">1</span></div>
        <div class="item"><span class="price">2</span></div>
      </div>
    `)
    expect(
      deriveLoopSelectorInPage(
        selectorsFor(
          '.list > div.item:nth-child(1) > span.price',
          '.list > div.item:nth-child(2) > span.price',
        ),
      ),
    ).toBe('.list > div.item > span.price')
  })

  it('strips :first-child/:last-child/:nth-of-type as well as :nth-child', () => {
    setBody(`
      <ul class="list">
        <li class="row">a</li>
        <li class="row">b</li>
      </ul>
    `)
    expect(
      deriveLoopSelectorInPage(
        selectorsFor('.list > li.row:first-child', '.list > li.row:last-child'),
      ),
    ).toBe('.list > li.row')
  })

  it('refuses when the stripped path also matches elements outside the run', () => {
    // The recorded run covers items 1-2 of four. `.list > li` would sweep in
    // items 3-4, so `loop-elements` would iterate four elements for two steps.
    setBody(`
      <ul class="list">
        <li>a</li><li>b</li><li>c</li><li>d</li>
      </ul>
    `)
    expect(
      deriveLoopSelectorInPage(selectorsFor('.list > li:nth-child(1)', '.list > li:nth-child(2)')),
    ).toBeNull()
  })

  it('refuses when the run order contradicts document order', () => {
    // `loop-elements` hands iteration N the N-th MATCH, so a candidate whose
    // document order differs from the recorded order is a wrong workflow even
    // though it "matches the same elements".
    setBody(`
      <div id="wrap">
        <div id="a" class="cell">x</div>
        <div id="b" class="cell">y</div>
      </div>
    `)
    expect(deriveLoopSelectorInPage(selectorsFor('#b', '#a'))).toBeNull()
  })
})

describe('deriveLoopSelectorInPage — candidates 2/3: tag and shared class', () => {
  it('narrows by a class every element carries, scoped to the common ancestor', () => {
    setBody(`
      <div id="form">
        <input id="input-1" class="field">
        <input id="input-2" class="field">
      </div>
    `)
    expect(deriveLoopSelectorInPage(selectorsFor('#input-1', '#input-2'))).toBe(
      '#form > input.field',
    )
  })

  it('falls back to the bare tag when there is no shared class', () => {
    setBody(`
      <div id="wrap">
        <div id="a">x</div>
        <div id="b">y</div>
      </div>
    `)
    expect(deriveLoopSelectorInPage(selectorsFor('#a', '#b'))).toBe('#wrap > div')
  })

  it('ignores a class only some of the elements carry', () => {
    setBody(`
      <div id="wrap">
        <div id="a" class="cell odd">x</div>
        <div id="b" class="cell">y</div>
      </div>
    `)
    expect(deriveLoopSelectorInPage(selectorsFor('#a', '#b'))).toBe('#wrap > div.cell')
  })

  it('refuses when an unrelated look-alike would be swept in', () => {
    // The two targets sit directly under <body>, so there is no ancestor to
    // scope to and every candidate over-matches. Refusing is the point.
    setBody(`
      <div id="a" class="cell">x</div>
      <div id="b" class="cell">y</div>
      <div class="cell">z</div>
    `)
    expect(deriveLoopSelectorInPage(selectorsFor('#a', '#b'))).toBeNull()
  })
})

describe('deriveLoopSelectorInPage — candidate 4: nested paths', () => {
  it('folds a run nested below the common ancestor', () => {
    // Candidates 2/3 only reach DIRECT children of the ancestor, so without
    // the stripped relative path this run would be refused.
    setBody(`
      <section id="sec">
        <div class="row"><b id="p1" class="v">1</b></div>
        <div class="row"><b id="p2" class="v">2</b></div>
      </section>
    `)
    expect(deriveLoopSelectorInPage(selectorsFor('#p1', '#p2'))).toBe('#sec > div > b')
  })

  it('refuses when the nested paths are not the same shape', () => {
    // One target is a grandchild, the other a great-grandchild: no single
    // relative path describes both.
    setBody(`
      <section id="sec">
        <div class="row"><b id="p1" class="v">1</b></div>
        <div><div class="row"><b id="p2" class="v">2</b></div></div>
      </section>
    `)
    expect(deriveLoopSelectorInPage(selectorsFor('#p1', '#p2'))).toBeNull()
  })

  it('falls back to a positional ancestor path when no ancestor has an id', () => {
    setBody(`
      <section>
        <div class="row"><b id="p1" class="v">1</b></div>
        <div class="row"><b id="p2" class="v">2</b></div>
      </section>
    `)
    expect(deriveLoopSelectorInPage(selectorsFor('#p1', '#p2'))).toBe(
      'body > section:nth-child(1) > div > b',
    )
  })

  it('prefers the shortest verified candidate over the verbose one', () => {
    setBody(`
      <div id="wrap">
        <div class="row"><b id="p1" class="v">1</b></div>
        <div class="row"><b id="p2" class="v">2</b></div>
      </div>
    `)
    // Both `#wrap > div > b` (candidate 4) and `#wrap > div.v`… — the class
    // candidate matches nothing (the class is on the <b>), so the relative
    // path wins, but the ancestor path is not tacked on when a shorter
    // candidate already verifies.
    expect(deriveLoopSelectorInPage(selectorsFor('#p1', '#p2'))).toBe('#wrap > div > b')
  })

  it('accepts a three-element run', () => {
    setBody(`
      <div id="wrap">
        <div class="row"><input id="i1" class="field"></div>
        <div class="row"><input id="i2" class="field"></div>
        <div class="row"><input id="i3" class="field"></div>
      </div>
    `)
    expect(deriveLoopSelectorInPage(selectorsFor('#i1', '#i2', '#i3'))).toBe('#wrap > div > input')
  })
})

describe('deriveLoopSelectorInPage — the injected source must be self-contained', () => {
  /**
   * Every case above calls the function with its MODULE SCOPE still in reach,
   * so none of them would notice a reference to a module-scope helper — and
   * that is precisely what breaks in production: `executeScript({ func })`
   * serialises the function's source and evaluates it in the page, where such
   * a reference is a `ReferenceError`. Rebuilding the function from its own
   * source reproduces the page's situation exactly.
   */
  const cases: { name: string; html: string; selectors: string[]; expected: string | null }[] = [
    {
      name: 'candidate 1 (stripped positional path)',
      html: `
        <div class="list">
          <div class="item"><span class="price">1</span></div>
          <div class="item"><span class="price">2</span></div>
        </div>`,
      selectors: [
        '.list > div.item:nth-child(1) > span.price',
        '.list > div.item:nth-child(2) > span.price',
      ],
      expected: '.list > div.item > span.price',
    },
    {
      name: 'candidate 2 (shared class)',
      html: `
        <div id="form">
          <input id="input-1" class="field">
          <input id="input-2" class="field">
        </div>`,
      selectors: ['#input-1', '#input-2'],
      expected: '#form > input.field',
    },
    {
      name: 'candidate 4 with a positional ancestor path',
      html: `
        <section>
          <div class="row"><b id="p1" class="v">1</b></div>
          <div class="row"><b id="p2" class="v">2</b></div>
        </section>`,
      selectors: ['#p1', '#p2'],
      expected: 'body > section:nth-child(1) > div > b',
    },
    {
      name: 'a refusal on element count',
      html: '<ul class="list"><li>a</li><li>b</li><li>c</li><li>d</li></ul>',
      selectors: ['.list > li:nth-child(1)', '.list > li:nth-child(2)'],
      expected: null,
    },
    {
      name: 'a refusal on a duplicate element',
      html: '<div id="dup"></div>',
      selectors: ['#dup', '#dup'],
      expected: null,
    },
    {
      name: 'a refusal on differing tags',
      html: '<div id="a"></div><span id="b"></span>',
      selectors: ['#a', '#b'],
      expected: null,
    },
    {
      name: 'a refusal on run order',
      html: '<div id="wrap"><div id="a" class="c">x</div><div id="b" class="c">y</div></div>',
      selectors: ['#b', '#a'],
      expected: null,
    },
  ]

  it('produces identical results when evaluated with no module bindings in scope', () => {
    // Rebuilt from source on purpose: this is what the page receives.
    const rebuilt = new Function(`return (${deriveLoopSelectorInPage.toString()})`)() as (
      selectors: string[],
    ) => string | null

    for (const { name, html, selectors, expected } of cases) {
      setBody(html)
      expect(deriveLoopSelectorInPage(selectors), `direct: ${name}`).toBe(expected)
      expect(rebuilt(selectors), `rebuilt: ${name}`).toBe(expected)
    }
  })
})

describe('createCollapseProbe', () => {
  /** A distinct window id per test keeps the tab cache from leaking between them. */
  const scopeOf = (windowId: number): ScopeWindow => ({ windowId })

  function stubChrome(executeScript: unknown, windowId: number): void {
    vi.stubGlobal('chrome', {
      windows: { get: vi.fn(async () => ({ id: windowId, type: 'normal' })) },
      tabs: {
        query: vi.fn(async () => [{ id: 42, windowId, url: 'https://example.com/' }]),
        get: vi.fn(async () => ({ id: 42, windowId, url: 'https://example.com/' })),
      },
      scripting: { executeScript },
    })
  }

  it('returns null without touching the page when the signal is already aborted', async () => {
    const executeScript = vi.fn()
    stubChrome(executeScript, 9001)
    const controller = new AbortController()
    controller.abort()
    const probe = createCollapseProbe(scopeOf(9001))
    await expect(probe.deriveLoopSelector(['#a', '#b'], controller.signal)).resolves.toBeNull()
    expect(executeScript).not.toHaveBeenCalled()
  })

  it('returns null without touching the page for a run shorter than two elements', async () => {
    const executeScript = vi.fn()
    stubChrome(executeScript, 9002)
    const probe = createCollapseProbe(scopeOf(9002))
    await expect(probe.deriveLoopSelector(['#a'], new AbortController().signal)).resolves.toBeNull()
    expect(executeScript).not.toHaveBeenCalled()
  })

  it('returns null when no injectable tab can be resolved', async () => {
    // No `chrome` at all: resolution rejects, and the probe must swallow it
    // rather than let it fail the whole fold.
    vi.stubGlobal('chrome', undefined)
    const probe = createCollapseProbe(scopeOf(9003))
    await expect(
      probe.deriveLoopSelector(['#a', '#b'], new AbortController().signal),
    ).resolves.toBeNull()
  })

  it('returns null when the injection itself throws', async () => {
    stubChrome(
      vi.fn(async () => {
        throw new Error('Cannot access contents of the page')
      }),
      9004,
    )
    const probe = createCollapseProbe(scopeOf(9004))
    await expect(
      probe.deriveLoopSelector(['#a', '#b'], new AbortController().signal),
    ).resolves.toBeNull()
  })

  it('returns the injected selector and caps each recorded selector at 300 chars', async () => {
    const long = `#${'x'.repeat(500)}`
    const executeScript = vi.fn<(request: { args: [string[]] }) => Promise<unknown>>(async () => [
      { result: '#form > input.field' },
    ])
    stubChrome(executeScript, 9005)
    const probe = createCollapseProbe(scopeOf(9005))
    await expect(
      probe.deriveLoopSelector([long, '#b'], new AbortController().signal),
    ).resolves.toBe('#form > input.field')
    const { args } = executeScript.mock.calls[0]![0]
    expect(args[0]![0]).toHaveLength(300)
    expect(args[0]![1]).toBe('#b')
  })

  it('treats an empty or non-string injection result as a refusal', async () => {
    stubChrome(
      vi.fn(async () => [{ result: '' }]),
      9006,
    )
    const probe = createCollapseProbe(scopeOf(9006))
    await expect(
      probe.deriveLoopSelector(['#a', '#b'], new AbortController().signal),
    ).resolves.toBeNull()

    stubChrome(
      vi.fn(async () => [{ result: { nope: true } }]),
      9007,
    )
    const other = createCollapseProbe(scopeOf(9007))
    await expect(
      other.deriveLoopSelector(['#a', '#b'], new AbortController().signal),
    ).resolves.toBeNull()
  })
})
