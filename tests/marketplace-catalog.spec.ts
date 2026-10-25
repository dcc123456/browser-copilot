import { describe, expect, it, vi } from 'vitest'
import type { GitHubIssue, GitHubPull, GitHubTreeEntry } from '../src/lib/marketplace/github-client'
import {
  MAX_CATALOG_ENTRIES,
  loadCatalog,
  mergeCatalog,
  readCatalog,
  slugsFromTree,
  type CatalogCache,
  type CatalogClient,
  type CatalogSnapshot,
} from '../src/lib/marketplace/catalog'
import { buildMeta } from '../src/lib/marketplace/meta'
import type { MarketplaceMeta } from '../src/lib/marketplace/types'

const NOW = new Date('2026-10-25T09:00:00.000Z')

function meta(slug: string, version = 1, updatedAt = NOW.toISOString()): MarketplaceMeta {
  return buildMeta({
    slug,
    title: `Workflow ${slug}`,
    description: '',
    category: 'other',
    author: 'octocat',
    version,
    hash: 'a'.repeat(64),
    now: new Date(updatedAt),
  })
}

function blob(path: string): GitHubTreeEntry {
  return { path, type: 'blob', sha: 'x' }
}

function pull(number: number, title: string, ref: string, merged = true): GitHubPull {
  return {
    number,
    title,
    html_url: `https://github.com/x/y/pull/${number}`,
    merged_at: merged ? NOW.toISOString() : null,
    head: { ref },
  }
}

function issue(number: number, likes: number, comments: number): GitHubIssue {
  return { number, comments, reactions: { '+1': likes }, pull_request: {} }
}

const TREE = [
  blob('workflows/a-111111/meta.json'),
  blob('workflows/a-111111/assets/1.webp'),
  blob('workflows/b-222222/meta.json'),
  blob('workflows/c-333333/meta.json'),
  blob('README.md'),
]

describe('mergeCatalog', () => {
  it('joins tree slugs with the latest merged PR and its counts', () => {
    const entries = mergeCatalog(
      TREE,
      [
        pull(5, 'Add workflow: A [wf:a-111111]', 'submit/a-111111-202610250900'),
        pull(9, 'Update workflow: B [wf:b-222222]', 'submit/b-222222-202610250901'),
        pull(10, 'Update workflow: B', 'submit/b-222222-202610250902'),
        pull(12, 'Add workflow: C [wf:c-333333]', 'submit/c-333333-202610250903', false),
        pull(13, 'Add workflow: D [wf:d-444444]', 'submit/d-444444-202610250904'),
      ],
      [issue(5, 1, 0), issue(10, 3, 2), issue(12, 5, 4)],
    )

    expect(entries).toEqual([
      { slug: 'a-111111', prNumber: 5, likes: 1, comments: 0 },
      { slug: 'b-222222', prNumber: 10, likes: 3, comments: 2 },
      { slug: 'c-333333', prNumber: null, likes: 0, comments: 0 },
    ])
  })

  it('keeps hand-added directories and ignores non-meta paths', () => {
    expect(slugsFromTree(TREE)).toEqual(['a-111111', 'b-222222', 'c-333333'])
    expect(slugsFromTree([blob('workflows/Bad Slug/meta.json')])).toEqual([])
    expect(mergeCatalog([blob('workflows/x-1/meta.json')], [], [])).toEqual([
      { slug: 'x-1', prNumber: null, likes: 0, comments: 0 },
    ])
  })
})

function client(overrides: Partial<CatalogClient> = {}): {
  api: CatalogClient
  calls: { tree: number; pulls: number; issues: number }
} {
  const calls = { tree: 0, pulls: 0, issues: 0 }
  const api: CatalogClient = {
    async listTree() {
      calls.tree += 1
      return { tree: TREE, truncated: false }
    },
    async listClosedPulls() {
      calls.pulls += 1
      return [pull(5, 'Add workflow: A [wf:a-111111]', 'submit/a-111111-202610250900')]
    },
    async listIssues() {
      calls.issues += 1
      return [issue(5, 2, 1)]
    },
    ...overrides,
  }
  return { api, calls }
}

function metaReader(): (slug: string) => Promise<MarketplaceMeta | null> {
  return async (slug) => (slug === 'c-333333' ? null : meta(slug))
}

describe('readCatalog', () => {
  it('loads every card with one call per endpoint', async () => {
    const { api, calls } = client()
    const snapshot = await readCatalog({ client: api, fetchMeta: metaReader(), now: () => 7 })

    expect(calls).toEqual({ tree: 1, pulls: 1, issues: 1 })
    expect(snapshot.fetchedAt).toBe(7)
    expect(snapshot.cards.map((card) => card.meta.slug)).toEqual(['a-111111', 'b-222222'])
    expect(snapshot.cards[0]).toMatchObject({ prNumber: 5, likes: 2, comments: 1 })
    expect(snapshot.truncated).toBe(false)
  })

  it('paginates until a short page and flags a full page cap', async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) =>
      pull(index + 1, `Add workflow: A [wf:a-111111]`, 'submit/a-111111-202610250900'),
    )
    const { api, calls } = client({
      async listClosedPulls(_owner, _repo, page = 1) {
        calls.pulls += 1
        return page === 1 ? fullPage : [fullPage[0]!]
      },
    })
    const paged = await readCatalog({ client: api, fetchMeta: metaReader(), now: () => 1 })
    expect(calls.pulls).toBe(2)
    expect(paged.truncated).toBe(false)

    const capped = client({
      async listClosedPulls() {
        calls.pulls += 1
        return fullPage
      },
    })
    const cappedSnapshot = await readCatalog({
      client: capped.api,
      fetchMeta: metaReader(),
      maxPages: 1,
      now: () => 1,
    })
    expect(cappedSnapshot.truncated).toBe(true)
  })

  it('surfaces a total metadata failure instead of an empty catalog', async () => {
    const { api } = client()
    await expect(
      readCatalog({
        client: api,
        fetchMeta: async () => {
          throw new Error('offline')
        },
      }),
    ).rejects.toMatchObject({ code: 'network' })
  })

  it('caps the displayed entries', async () => {
    const many = Array.from({ length: MAX_CATALOG_ENTRIES + 5 }, (_, index) => `wf-${index}`)
    const { api } = client({
      async listTree() {
        return { tree: many.map((slug) => blob(`workflows/${slug}/meta.json`)), truncated: false }
      },
      async listClosedPulls() {
        return []
      },
      async listIssues() {
        return []
      },
    })
    const snapshot = await readCatalog({
      client: api,
      fetchMeta: async (slug) => meta(slug),
      now: () => 1,
    })
    expect(snapshot.cards).toHaveLength(MAX_CATALOG_ENTRIES)
    expect(snapshot.truncated).toBe(true)
  })
})

function memoryCache(initial: CatalogSnapshot | null): CatalogCache & { saved: CatalogSnapshot[] } {
  let value = initial
  const saved: CatalogSnapshot[] = []
  return {
    saved,
    async load() {
      return value
    },
    async save(snapshot) {
      value = snapshot
      saved.push(snapshot)
    },
  }
}

describe('loadCatalog', () => {
  it('serves a snapshot younger than the TTL without touching the network', async () => {
    const cache = memoryCache({ fetchedAt: 1000, cards: [], truncated: false })
    const api = vi.fn() as unknown as CatalogClient
    const result = await loadCatalog({ client: api, cache, now: () => 1000 + 60_000 })
    expect(result).toMatchObject({ fromCache: true, stale: false, fetchedAt: 1000 })
  })

  it('refreshes when stale or forced and stores the result', async () => {
    const snapshot: CatalogSnapshot = { fetchedAt: 1000, cards: [], truncated: false }
    const cache = memoryCache(snapshot)
    const { api } = client()
    const result = await loadCatalog({
      client: api,
      cache,
      fetchMeta: metaReader(),
      now: () => 1000 + 31 * 60_000,
    })
    expect(result.fromCache).toBe(false)
    expect(cache.saved).toHaveLength(1)

    const forced = await loadCatalog({
      client: api,
      cache,
      fetchMeta: metaReader(),
      force: true,
      now: () => 2000,
    })
    expect(forced.fromCache).toBe(false)
  })

  it('falls back to the cache when the refresh fails', async () => {
    const cached: CatalogSnapshot = { fetchedAt: 1000, cards: [], truncated: false }
    const { api } = client({
      async listTree() {
        throw new Error('offline')
      },
    })
    const result = await loadCatalog({
      client: api,
      cache: memoryCache(cached),
      now: () => 1000 + 2 * 60 * 60 * 1000,
    })
    expect(result).toMatchObject({ fromCache: true, stale: true, fetchedAt: 1000 })
  })

  it('rethrows without a cache', async () => {
    const { api } = client({
      async listTree() {
        throw new Error('offline')
      },
    })
    await expect(loadCatalog({ client: api })).rejects.toThrow('offline')
  })
})
