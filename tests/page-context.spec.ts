/**
 * Page-context guard tests (spec §11, Phase 10): a strict run must refuse to
 * act on the wrong origin/page with a structured WRONG_ORIGIN / WRONG_PAGE
 * failure, and must not gate when the workflow carries no grounding.
 */
import { describe, expect, it } from 'vitest'
import {
  checkPageContext,
  navigationDestinationOf,
  originOfUrl,
  pageContextOf,
  recordedPageContext,
} from '../src/lib/workflow/page-context'
import { ELEMENT_OP_BLOCKS } from '../src/lib/workflow/generated-validation'

describe('pageContextOf', () => {
  it('derives the origin from generationOriginUrl', () => {
    expect(
      pageContextOf({ settings: { generationOriginUrl: 'https://shop.test/cart?x=1' } }),
    ).toEqual({
      origin: 'https://shop.test',
    })
  })

  it('prefers an explicit pageContext and normalizes blanks away', () => {
    expect(
      pageContextOf({
        settings: {
          generationOriginUrl: 'https://a.test',
          pageContext: {
            origin: ' https://b.test ',
            pathnamePattern: ' /docs/* ',
            titleHint: ' Docs ',
          },
        },
      }),
    ).toEqual({ origin: 'https://b.test', pathnamePattern: '/docs/*', titleHint: 'Docs' })
  })

  it('derives nothing when there is no grounding (never invent a guard)', () => {
    expect(pageContextOf({ settings: {} })).toBeUndefined()
    expect(pageContextOf({ settings: { generationOriginUrl: 'not a url' } })).toBeUndefined()
  })
})

describe('checkPageContext', () => {
  const expected = { origin: 'https://shop.test', pathnamePattern: '/docs/*', titleHint: '帮助' }

  it('refuses a different origin with WRONG_ORIGIN — even with a matching path', () => {
    const verdict = checkPageContext(expected, {
      url: 'https://evil.test/docs/start',
      title: '帮助中心',
    })
    expect(verdict.ok).toBe(false)
    expect(!verdict.ok && verdict.code).toBe('WRONG_ORIGIN')
  })

  it('refuses a wrong pathname on the right origin with WRONG_PAGE', () => {
    const verdict = checkPageContext(expected, { url: 'https://shop.test/settings', title: '帮助' })
    expect(verdict.ok).toBe(false)
    expect(!verdict.ok && verdict.code).toBe('WRONG_PAGE')
  })

  it('passes on the right origin, matching path and title', () => {
    expect(
      checkPageContext(expected, { url: 'https://shop.test/docs/start', title: '帮助中心' }),
    ).toEqual({ ok: true })
  })

  it('an unobservable page does not fail the guard (no invented failures)', () => {
    expect(checkPageContext(expected, {})).toEqual({ ok: true })
  })

  it('title check is case-insensitive and skipped when no title is observable', () => {
    expect(
      checkPageContext(
        { origin: 'https://x.test', titleHint: 'ADMIN' },
        { url: 'https://x.test/', title: 'admin panel' },
      ).ok,
    ).toBe(true)
    expect(
      checkPageContext({ origin: 'https://x.test', titleHint: 'ADMIN' }, { url: 'https://x.test/' })
        .ok,
    ).toBe(true)
  })

  it('names the compared subject so a destination is never reported as the current page', () => {
    const current = checkPageContext({ origin: 'https://shop.test' }, { url: 'https://other.test' })
    expect(!current.ok && current.message).toContain('当前页面')
    const destination = checkPageContext(
      { origin: 'https://shop.test' },
      { url: 'https://other.test' },
      { label: '导航目标' },
    )
    expect(!destination.ok && destination.message).toContain('导航目标（https://other.test）')
    expect(!destination.ok && destination.message).not.toContain('当前页面')
  })
})

describe('navigationDestinationOf', () => {
  it('returns the destination of a navigation block with a static http(s) url', () => {
    expect(navigationDestinationOf('new-tab', { url: 'https://creator.test/publish' })).toBe(
      'https://creator.test/publish',
    )
    expect(navigationDestinationOf('open-url', { url: '  http://localhost:3000/  ' })).toBe(
      'http://localhost:3000/',
    )
  })

  it('refuses to anchor on anything the engine cannot resolve yet', () => {
    expect(navigationDestinationOf('new-tab', { url: '{{target}}' })).toBeUndefined()
    expect(navigationDestinationOf('new-tab', { url: 'https://a.test/{{path}}' })).toBeUndefined()
    expect(navigationDestinationOf('new-tab', { url: 'file:///tmp/x.html' })).toBeUndefined()
    expect(navigationDestinationOf('new-tab', { url: 'not a url' })).toBeUndefined()
    expect(navigationDestinationOf('new-tab', {})).toBeUndefined()
    expect(navigationDestinationOf('event-click', { url: 'https://a.test/' })).toBeUndefined()
  })
})

describe('guard coverage', () => {
  it('page-acting blocks are covered by the element-op set plus navigation blocks', () => {
    for (const blockId of ['event-click', 'forms', 'get-text', 'element-exists']) {
      expect(ELEMENT_OP_BLOCKS.has(blockId)).toBe(true)
    }
    expect(originOfUrl('https://shop.test/x?y=1')).toBe('https://shop.test')
  })
})

/**
 * A workflow is single-anchored but not single-SITE. The regression this pins:
 * a goal that read a README on github.com and then published on
 * creator.xiaohongshu.com had its OWN first step refused in 6ms
 * (WRONG_ORIGIN), so its pre-save verification never executed a step.
 */
describe('cross-site workflows', () => {
  const crossSite = {
    origin: 'https://creator.xiaohongshu.com',
    additionalOrigins: ['https://github.com'],
    pathnamePattern: '/new/*',
  }

  it('accepts every origin the session really acted on', () => {
    expect(checkPageContext(crossSite, { url: 'https://github.com/o/r' })).toEqual({ ok: true })
    expect(
      checkPageContext(crossSite, { url: 'https://creator.xiaohongshu.com/new/home' }),
    ).toEqual({
      ok: true,
    })
  })

  it('still refuses a site outside the recorded set, and names the whole set', () => {
    const verdict = checkPageContext(crossSite, { url: 'https://evil.test/o/r' })
    expect(!verdict.ok && verdict.code).toBe('WRONG_ORIGIN')
    expect(!verdict.ok && verdict.message).toContain('https://creator.xiaohongshu.com')
    expect(!verdict.ok && verdict.message).toContain('https://github.com')
  })

  it("does not enforce the primary site's path pattern on a secondary origin", () => {
    // The pattern describes the anchor site's page; github has no recorded path.
    expect(checkPageContext(crossSite, { url: 'https://github.com/anything' })).toEqual({
      ok: true,
    })
    expect(
      checkPageContext(crossSite, { url: 'https://creator.xiaohongshu.com/settings' }).ok,
    ).toBe(false)
  })

  it('normalizes a stored set: parseable, deduped, primary never repeated', () => {
    expect(
      pageContextOf({
        settings: {
          pageContext: {
            origin: 'https://b.test',
            additionalOrigins: [
              'https://c.test/x',
              'https://b.test/other',
              'https://c.test/y',
              'not a url',
              42,
            ],
          },
        },
      }),
    ).toEqual({ origin: 'https://b.test', additionalOrigins: ['https://c.test'] })
  })

  it('omits the field entirely for a single-site workflow', () => {
    expect(pageContextOf({ settings: { pageContext: { origin: 'https://b.test' } } })).toEqual({
      origin: 'https://b.test',
    })
  })
})

describe('recordedPageContext', () => {
  it('states the anchor plus the other sites the session acted on', () => {
    expect(
      recordedPageContext('https://github.com/o/r', [
        'https://github.com',
        'https://creator.xiaohongshu.com',
      ]),
    ).toEqual({
      origin: 'https://github.com',
      additionalOrigins: ['https://creator.xiaohongshu.com'],
    })
  })

  it('returns nothing when there is no second site to state', () => {
    // A single site is already covered by deriving from generationOriginUrl;
    // writing a fingerprint would freeze an anchor the repair may still move.
    expect(recordedPageContext('https://github.com/o/r', ['https://github.com'])).toBeUndefined()
    expect(recordedPageContext('https://github.com/o/r', undefined)).toBeUndefined()
    expect(recordedPageContext('https://github.com/o/r', [])).toBeUndefined()
  })

  it('never invents an anchor', () => {
    expect(recordedPageContext(undefined, ['https://a.test'])).toBeUndefined()
    expect(recordedPageContext('not a url', ['https://a.test'])).toBeUndefined()
  })
})
