import { describe, expect, it } from 'vitest'
import {
  buildMeta,
  isMarketplaceRef,
  needsUpdate,
  parseMeta,
  workflowHash,
} from '../src/lib/marketplace/meta'
import type { MarketplaceMeta } from '../src/lib/marketplace/types'
import type { WorkflowMarketplaceRef } from '../src/lib/workflow/types'

const NOW = new Date('2026-10-25T09:00:00.000Z')
const HASH = 'a'.repeat(64)

function makeMeta(): MarketplaceMeta {
  return buildMeta({
    slug: 'scrape-orders-abcdef',
    title: 'Scrape orders',
    description: 'Open the orders page and copy every row.',
    category: 'ecommerce',
    tags: ['shop', 'orders'],
    author: 'octocat',
    version: 1,
    hash: HASH,
    imageCount: 2,
    videoUrl: 'https://example.com/video',
    now: NOW,
  })
}

describe('workflow hash', () => {
  it('matches the published SHA-256 of the exact bytes', async () => {
    expect(await workflowHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('marketplace meta', () => {
  it('builds and parses a valid record', () => {
    const meta = makeMeta()
    expect(meta.images).toEqual(['assets/1.webp', 'assets/2.webp'])
    const parsed = parseMeta(JSON.parse(JSON.stringify(meta)))
    expect(parsed).toEqual(meta)
  })

  it('rejects records whose identity cannot be trusted', () => {
    const meta = makeMeta()
    expect(parseMeta({ ...meta, schema: 2 })).toBeNull()
    expect(parseMeta({ ...meta, slug: 'Bad Slug' })).toBeNull()
    expect(parseMeta({ ...meta, version: 0 })).toBeNull()
    expect(parseMeta({ ...meta, hash: 'not-a-hash' })).toBeNull()
    expect(parseMeta({ ...meta, author: '' })).toBeNull()
    expect(parseMeta(null)).toBeNull()
    expect(parseMeta('meta')).toBeNull()
  })

  it('maps an unknown category to other instead of dropping the card', () => {
    const parsed = parseMeta({ ...makeMeta(), category: 'brand-new' })
    expect(parsed?.category).toBe('other')
  })

  it('drops unsafe asset paths and non-http video links', () => {
    const parsed = parseMeta({
      ...makeMeta(),
      images: ['assets/../../etc/passwd', 'assets/1.webp'],
      videoUrl: 'javascript:alert(1)',
    })
    expect(parsed?.images).toEqual(['assets/1.webp'])
    expect(parsed?.videoUrl).toBeUndefined()
  })

  it('refuses to build a publishable record with bad input', () => {
    expect(() => buildMeta({ ...makeMetaInput(), slug: 'Bad Slug' })).toThrow()
    expect(() => buildMeta({ ...makeMetaInput(), title: '   ' })).toThrow()
    expect(() => buildMeta({ ...makeMetaInput(), videoUrl: 'ftp://example.com/v' })).toThrow()
    expect(() => buildMeta({ ...makeMetaInput(), imageCount: 4 })).toThrow()
  })
})

function makeMetaInput() {
  return {
    slug: 'scrape-orders-abcdef',
    title: 'Scrape orders',
    description: '',
    category: 'ecommerce' as const,
    author: 'octocat',
    version: 1,
    hash: HASH,
  }
}

describe('marketplace ref', () => {
  const ref: WorkflowMarketplaceRef = {
    repo: 'dcc123456/BC-workflow',
    slug: 'scrape-orders-abcdef',
    version: 2,
    hash: HASH,
    author: 'octocat',
    appliedAt: 1,
  }

  it('accepts a well-formed ref and rejects partial ones', () => {
    expect(isMarketplaceRef(ref)).toBe(true)
    expect(isMarketplaceRef({ ...ref, slug: 'Bad' })).toBe(false)
    expect(isMarketplaceRef({ ...ref, hash: '' })).toBe(false)
    expect(isMarketplaceRef(null)).toBe(false)
  })

  it('flags an update only when the upstream version moved', () => {
    const meta = makeMeta()
    expect(needsUpdate(meta, ref)).toBe(false)
    expect(needsUpdate({ ...meta, version: 3 }, ref)).toBe(true)
    expect(needsUpdate({ ...meta, version: 3 }, { ...ref, slug: 'other-slug' })).toBe(false)
    expect(needsUpdate(meta, undefined)).toBe(false)
  })
})
