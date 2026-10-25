import { describe, expect, it } from 'vitest'
import { buildSlug, isValidSlug, slugify } from '../src/lib/marketplace/slug'

describe('marketplace slug', () => {
  it('builds an ascii stem from a display name', () => {
    expect(slugify('Scrape Amazon Orders')).toBe('scrape-amazon-orders')
    expect(slugify('  Café  List  ')).toBe('cafe-list')
  })

  it('returns an empty stem when the name has no latin characters', () => {
    expect(slugify('小红书发布笔记')).toBe('')
  })

  it('always appends a six-character hash suffix', () => {
    expect(buildSlug('Scrape Orders', 'ABCDEF123456')).toBe('scrape-orders-abcdef')
    expect(buildSlug('小红书发布笔记', 'deadbeef')).toBe('wf-deadbe')
  })

  it('keeps two same-named workflows apart', () => {
    expect(buildSlug('Publish note', 'aaaaaa11')).not.toBe(buildSlug('Publish note', 'bbbbbb22'))
  })

  it('validates only lowercase dash-separated slugs', () => {
    expect(isValidSlug('scrape-orders-abcdef')).toBe(true)
    expect(isValidSlug('Scrape-Orders')).toBe(false)
    expect(isValidSlug('-leading')).toBe(false)
    expect(isValidSlug('trailing-')).toBe(false)
    expect(isValidSlug('double--dash')).toBe(false)
    expect(isValidSlug('')).toBe(false)
  })
})
