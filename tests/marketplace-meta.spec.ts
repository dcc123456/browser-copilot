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

  it('keeps a publisher-defined category instead of dropping it', () => {
    const parsed = parseMeta({ ...makeMeta(), category: '  Industry   research ' })
    expect(parsed?.category).toBe('Industry research')
  })

  it('normalises a custom category when building a record', () => {
    const meta = buildMeta({ ...makeMetaInput(), category: '  Industry research ' })
    expect(meta.category).toBe('Industry research')
  })

  it('falls back to other when the category is missing or unusable', () => {
    expect(parseMeta({ ...makeMeta(), category: '   ' })?.category).toBe('other')
    expect(parseMeta({ ...makeMeta(), category: 42 })?.category).toBe('other')
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
    expect(() => buildMeta({ ...makeMetaInput(), category: '   ' })).toThrow()
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

describe('marketplace meta — bundled dependencies', () => {
  const dependency = {
    id: 'child-1',
    name: 'Collect numbers',
    path: 'deps/collect-numbers.json',
  }

  it('round-trips the called workflows', () => {
    const meta = buildMeta({ ...makeMetaInput(), dependencies: [dependency] })
    expect(meta.dependencies).toEqual([dependency])
    expect(parseMeta(JSON.parse(JSON.stringify(meta)))).toEqual(meta)
  })

  it('omits the field for a listing that calls nothing', () => {
    expect(makeMeta().dependencies).toBeUndefined()
    expect(parseMeta({ ...makeMeta(), dependencies: [] })?.dependencies).toBeUndefined()
  })

  it('falls back to the id when a dependency name is unusable', () => {
    const parsed = parseMeta({
      ...makeMeta(),
      dependencies: [{ ...dependency, name: 7 }],
    })
    expect(parsed?.dependencies).toEqual([{ ...dependency, name: 'child-1' }])
  })

  it('rejects a bundle list apply could not resolve', () => {
    expect(parseMeta({ ...makeMeta(), dependencies: 'nope' })).toBeNull()
    expect(parseMeta({ ...makeMeta(), dependencies: [{ ...dependency, id: '  ' }] })).toBeNull()
    expect(
      parseMeta({ ...makeMeta(), dependencies: [{ ...dependency, path: 'deps/../x.json' }] }),
    ).toBeNull()
    expect(
      parseMeta({
        ...makeMeta(),
        dependencies: [dependency, { ...dependency, path: 'deps/other.json' }],
      }),
    ).toBeNull()
  })

  it('refuses to build a record with a path apply cannot read', () => {
    expect(() =>
      buildMeta({ ...makeMetaInput(), dependencies: [{ ...dependency, path: 'collect.json' }] }),
    ).toThrow()
    expect(() =>
      buildMeta({ ...makeMetaInput(), dependencies: [{ ...dependency, name: ' ' }] }),
    ).toThrow()
  })
})

describe('marketplace meta — attachments', () => {
  const attachment = { name: 'Orders 模板.csv', path: 'attachments/orders.csv', size: 2048 }

  it('round-trips the attachment list', () => {
    const meta = buildMeta({ ...makeMetaInput(), attachments: [attachment] })
    expect(meta.attachments).toEqual([attachment])
    expect(parseMeta(JSON.parse(JSON.stringify(meta)))).toEqual(meta)
  })

  it('omits the field when nothing is attached', () => {
    expect(makeMeta().attachments).toBeUndefined()
    expect(parseMeta({ ...makeMeta(), attachments: [] })?.attachments).toBeUndefined()
  })

  it('drops unusable entries instead of rejecting the whole card', () => {
    const parsed = parseMeta({
      ...makeMeta(),
      attachments: [
        attachment,
        { ...attachment, path: 'attachments/../secret' },
        { ...attachment, path: 'attachments/orders.csv' },
        { ...attachment, path: 'attachments/orders-2.csv', name: '   ' },
        { ...attachment, path: 'attachments/orders-3.csv', size: 200 * 1024 + 1 },
        'nope',
      ],
    })
    expect(parsed?.attachments).toEqual([attachment])
    expect(parseMeta({ ...makeMeta(), attachments: 'nope' })?.attachments).toBeUndefined()
  })

  it('refuses to build a record with an unsafe or oversized attachment', () => {
    expect(() =>
      buildMeta({ ...makeMetaInput(), attachments: [{ ...attachment, path: 'attachments/a/b' }] }),
    ).toThrow()
    expect(() =>
      buildMeta({ ...makeMetaInput(), attachments: [{ ...attachment, name: ' ' }] }),
    ).toThrow()
    expect(() =>
      buildMeta({
        ...makeMetaInput(),
        attachments: [{ ...attachment, size: 200 * 1024 + 1 }],
      }),
    ).toThrow()
    expect(() =>
      buildMeta({
        ...makeMetaInput(),
        attachments: [attachment, attachment, attachment, { ...attachment, path: 'attachments/x' }],
      }),
    ).toThrow()
  })
})

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
