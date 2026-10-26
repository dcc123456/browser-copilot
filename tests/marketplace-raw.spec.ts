import { describe, expect, it, vi } from 'vitest'
import { fetchPublishedMeta, fetchRawText, rawUrl } from '../src/lib/marketplace/raw'
import { buildMeta } from '../src/lib/marketplace/meta'

function fetchReturning(body: string, status = 200): typeof fetch {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch
}

describe('raw CDN reads', () => {
  it('encodes each path segment', () => {
    expect(rawUrl('workflows/a b/meta.json')).toBe(
      'https://raw.githubusercontent.com/dcc123456/BC-workflow/main/workflows/a%20b/meta.json',
    )
  })

  it('returns null for a missing file and text otherwise', async () => {
    await expect(
      fetchRawText('workflows/x/meta.json', fetchReturning('nope', 404)),
    ).resolves.toBeNull()
    await expect(fetchRawText('workflows/x/meta.json', fetchReturning('{"a":1}'))).resolves.toBe(
      '{"a":1}',
    )
  })

  it('wraps transport failures as network errors', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    await expect(fetchRawText('x', failing)).rejects.toMatchObject({ code: 'network' })
  })

  it('parses a published meta and ignores corrupt JSON', async () => {
    const meta = buildMeta({
      slug: 'scrape-orders-abcdef',
      title: 'Scrape orders',
      description: '',
      category: 'ecommerce',
      author: 'octocat',
      version: 2,
      hash: 'a'.repeat(64),
    })
    await expect(
      fetchPublishedMeta('scrape-orders-abcdef', fetchReturning(JSON.stringify(meta))),
    ).resolves.toEqual(meta)
    await expect(
      fetchPublishedMeta('scrape-orders-abcdef', fetchReturning('{oops')),
    ).resolves.toBeNull()
    await expect(
      fetchPublishedMeta('scrape-orders-abcdef', fetchReturning('', 404)),
    ).resolves.toBeNull()
  })

  it('bypasses the five-minute raw cache when reading a meta', async () => {
    const meta = buildMeta({
      slug: 'scrape-orders-abcdef',
      title: 'Scrape orders',
      description: '',
      category: 'ecommerce',
      author: 'octocat',
      version: 2,
      hash: 'a'.repeat(64),
    })
    const urls: string[] = []
    const recorder = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify(meta))
    }) as unknown as typeof fetch

    await expect(fetchPublishedMeta('scrape-orders-abcdef', recorder)).resolves.toEqual(meta)
    expect(urls[0]).toMatch(/\/workflows\/scrape-orders-abcdef\/meta\.json\?v=\d+$/)
  })
})
