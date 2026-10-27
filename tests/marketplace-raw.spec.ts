import { describe, expect, it, vi } from 'vitest'
import {
  fetchPublishedMeta,
  fetchRawText,
  fetchRepoAsset,
  fetchRepoMeta,
  fetchRepoText,
  fetchRepoWorkflow,
  rawUrl,
} from '../src/lib/marketplace/raw'
import type { GitHubClient } from '../src/lib/marketplace/github-client'
import { buildMeta } from '../src/lib/marketplace/meta'
import { PUBLIC_REPO, type RepoRef } from '../src/lib/marketplace/repo'

function fetchReturning(body: string, status = 200): typeof fetch {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch
}

describe('raw CDN reads', () => {
  it('encodes each path segment', () => {
    expect(rawUrl(PUBLIC_REPO, 'workflows/a b/meta.json')).toBe(
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

const TEAM_REPO: RepoRef = {
  owner: 'acme',
  repo: 'team-workflows',
  branch: 'main',
  isPrivate: true,
}

function clientStub(files: Record<string, string | Blob>): GitHubClient {
  return {
    authenticated: true,
    async getFileText(_owner: string, _repo: string, path: string) {
      const value = files[path]
      return typeof value === 'string' ? value : null
    },
    async getFileBlob(_owner: string, _repo: string, path: string) {
      const value = files[path]
      return value instanceof Blob ? value : null
    },
  } as unknown as GitHubClient
}

describe('private repo reads', () => {
  it('reads text through the client instead of the raw host', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const client = clientStub({ 'workflows/demo-1/meta.json': '{"slug":"demo-1"}' })
    await expect(
      fetchRepoText(TEAM_REPO, 'workflows/demo-1/meta.json', { client, fetchImpl }),
    ).resolves.toBe('{"slug":"demo-1"}')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses to read a private repo without a token', async () => {
    await expect(fetchRepoText(TEAM_REPO, 'workflows/demo-1/meta.json')).rejects.toMatchObject({
      code: 'auth-required',
    })
    const anonymous = { authenticated: false } as unknown as GitHubClient
    await expect(fetchRepoMeta(TEAM_REPO, 'demo-1', { client: anonymous })).rejects.toMatchObject({
      code: 'auth-required',
    })
  })

  it('returns null for an absent private meta and asset', async () => {
    const client = clientStub({})
    await expect(fetchRepoMeta(TEAM_REPO, 'demo-1', { client })).resolves.toBeNull()
    await expect(
      fetchRepoAsset(TEAM_REPO, 'demo-1', 'assets/cover.webp', { client }),
    ).resolves.toBeNull()
  })

  it('reads a private asset as a blob', async () => {
    const client = clientStub({ 'workflows/demo-1/assets/cover.webp': new Blob(['IMG']) })
    const blob = await fetchRepoAsset(TEAM_REPO, 'demo-1', 'assets/cover.webp', { client })
    await expect(blob!.text()).resolves.toBe('IMG')
  })

  it('reads a private workflow and rejects corrupt JSON', async () => {
    const client = clientStub({ 'workflows/demo-1/workflow.json': '{"nodes":[]}' })
    await expect(fetchRepoWorkflow(TEAM_REPO, 'demo-1', { client })).resolves.toEqual({
      nodes: [],
    })

    const corrupt = clientStub({ 'workflows/demo-1/workflow.json': '{oops' })
    await expect(fetchRepoWorkflow(TEAM_REPO, 'demo-1', { client: corrupt })).rejects.toMatchObject(
      { code: 'invalid' },
    )
  })
})
