/**
 * Page-context guard tests (spec §11, Phase 10): a strict run must refuse to
 * act on the wrong origin/page with a structured WRONG_ORIGIN / WRONG_PAGE
 * failure, and must not gate when the workflow carries no grounding.
 */
import { describe, expect, it } from 'vitest'
import {
  checkPageContext,
  originOfUrl,
  pageContextOf,
} from '../src/lib/workflow/page-context'
import { ELEMENT_OP_BLOCKS } from '../src/lib/workflow/generated-validation'

describe('pageContextOf', () => {
  it('derives the origin from generationOriginUrl', () => {
    expect(pageContextOf({ settings: { generationOriginUrl: 'https://shop.test/cart?x=1' } })).toEqual({
      origin: 'https://shop.test',
    })
  })

  it('prefers an explicit pageContext and normalizes blanks away', () => {
    expect(
      pageContextOf({
        settings: {
          generationOriginUrl: 'https://a.test',
          pageContext: { origin: ' https://b.test ', pathnamePattern: ' /docs/* ', titleHint: ' Docs ' },
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
    const verdict = checkPageContext(expected, { url: 'https://evil.test/docs/start', title: '帮助中心' })
    expect(verdict.ok).toBe(false)
    expect(!verdict.ok && verdict.code).toBe('WRONG_ORIGIN')
  })

  it('refuses a wrong pathname on the right origin with WRONG_PAGE', () => {
    const verdict = checkPageContext(expected, { url: 'https://shop.test/settings', title: '帮助' })
    expect(verdict.ok).toBe(false)
    expect(!verdict.ok && verdict.code).toBe('WRONG_PAGE')
  })

  it('passes on the right origin, matching path and title', () => {
    expect(checkPageContext(expected, { url: 'https://shop.test/docs/start', title: '帮助中心' })).toEqual({ ok: true })
  })

  it('an unobservable page does not fail the guard (no invented failures)', () => {
    expect(checkPageContext(expected, {})).toEqual({ ok: true })
  })

  it('title check is case-insensitive and skipped when no title is observable', () => {
    expect(checkPageContext({ origin: 'https://x.test', titleHint: 'ADMIN' }, { url: 'https://x.test/', title: 'admin panel' }).ok).toBe(true)
    expect(checkPageContext({ origin: 'https://x.test', titleHint: 'ADMIN' }, { url: 'https://x.test/' }).ok).toBe(true)
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
