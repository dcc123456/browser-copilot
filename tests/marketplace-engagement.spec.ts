/**
 * Likes and comments: the reaction id is what makes "unlike" possible at all,
 * so these tests pin the cache contract as much as the HTTP calls.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  listAllComments,
  postComment,
  toggleLike,
  type EngagementClient,
  type ReactionCache,
} from '../src/lib/marketplace/engagement'
import type { GitHubComment, GitHubReaction } from '../src/lib/marketplace/github-client'
import { MarketplaceError } from '../src/lib/marketplace/types'

function memoryCache(initial: Record<number, number> = {}): ReactionCache & {
  values: Map<number, number>
  cleared: number
} {
  const values = new Map<number, number>(Object.entries(initial).map(([k, v]) => [Number(k), v]))
  const state = {
    values,
    cleared: 0,
    async get(issueNumber: number) {
      return values.get(issueNumber) ?? null
    },
    async set(issueNumber: number, reactionId: number | null) {
      if (reactionId === null) values.delete(issueNumber)
      else values.set(issueNumber, reactionId)
    },
    async clear() {
      state.cleared += 1
      values.clear()
    },
  }
  return state
}

function comment(id: number): GitHubComment {
  return {
    id,
    body: `comment ${id}`,
    html_url: `https://github.com/o/r/pull/7#issuecomment-${id}`,
    created_at: '2026-10-25T09:00:00Z',
    user: { login: 'octocat' },
  }
}

function fakeClient(overrides: Partial<EngagementClient> = {}): EngagementClient & {
  calls: { add: number; remove: number[]; list: number[]; created: string[] }
} {
  const calls = { add: 0, remove: [] as number[], list: [] as number[], created: [] as string[] }
  const client = {
    authenticated: true,
    calls,
    async addReaction(): Promise<GitHubReaction> {
      calls.add += 1
      return { id: 900, content: '+1', user: { login: 'me' } }
    },
    async deleteReaction(_o: string, _r: string, _n: number, reactionId: number) {
      calls.remove.push(reactionId)
    },
    async listComments(_o: string, _r: string, _n: number, page = 1): Promise<GitHubComment[]> {
      calls.list.push(page)
      return page === 1 ? [comment(1), comment(2)] : []
    },
    async createComment(_o: string, _r: string, _n: number, body: string): Promise<GitHubComment> {
      calls.created.push(body)
      return comment(3)
    },
    ...overrides,
  }
  return client as EngagementClient & typeof client
}

describe('toggleLike', () => {
  it('likes once and remembers the reaction id', async () => {
    const client = fakeClient()
    const cache = memoryCache()

    const result = await toggleLike({ client, cache, issueNumber: 7 })

    expect(result).toEqual({ liked: true })
    expect(client.calls.add).toBe(1)
    expect(cache.values.get(7)).toBe(900)
  })

  it('unlikes the recorded reaction instead of adding a second +1', async () => {
    const client = fakeClient()
    const cache = memoryCache({ 7: 900 })

    const result = await toggleLike({ client, cache, issueNumber: 7 })

    expect(result).toEqual({ liked: false })
    expect(client.calls.add).toBe(0)
    expect(client.calls.remove).toEqual([900])
    expect(cache.values.has(7)).toBe(false)
  })

  it('refuses to write without a token', async () => {
    const client = fakeClient({ authenticated: false } as Partial<EngagementClient>)
    await expect(
      toggleLike({ client, cache: memoryCache(), issueNumber: 7 }),
    ).rejects.toMatchObject({ code: 'auth-required' })
    expect(client.calls.add).toBe(0)
  })

  it('drops the credential and the reaction ids when GitHub rejects the token', async () => {
    const client = fakeClient({
      authenticated: true,
      async deleteReaction() {
        throw new MarketplaceError('unauthorized', 'bad token', 401)
      },
    } as Partial<EngagementClient>)
    const cache = memoryCache({ 7: 900 })
    const onUnauthorized = vi.fn()

    await expect(
      toggleLike({ client, cache, issueNumber: 7, onUnauthorized }),
    ).rejects.toMatchObject({ code: 'unauthorized' })

    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(cache.cleared).toBe(1)
    expect(cache.values.size).toBe(0)
  })
})

describe('comments', () => {
  it('reads the whole thread and stops on a short page', async () => {
    const client = fakeClient()
    const comments = await listAllComments(client, 7)

    expect(comments.map((item) => item.id)).toEqual([1, 2])
    expect(client.calls.list).toEqual([1])
  })

  it('keeps paging while pages are full, up to the cap', async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => comment(index + 1))
    const client = fakeClient({
      async listComments(_o, _r, _n, page = 1) {
        return page <= 2 ? fullPage : []
      },
    } as Partial<EngagementClient>)

    const comments = await listAllComments(client, 7, 3)

    expect(comments).toHaveLength(200)
  })

  it('posts a trimmed comment and returns it', async () => {
    const client = fakeClient()
    const posted = await postComment({
      client,
      cache: memoryCache(),
      issueNumber: 7,
      body: '  looks useful  ',
    })

    expect(posted.id).toBe(3)
    expect(client.calls.created).toEqual(['looks useful'])
  })

  it('refuses an empty comment before any request', async () => {
    const client = fakeClient()
    await expect(
      postComment({ client, cache: memoryCache(), issueNumber: 7, body: '   ' }),
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(client.calls.created).toEqual([])
  })
})
