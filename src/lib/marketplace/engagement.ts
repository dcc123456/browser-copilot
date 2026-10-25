/**
 * Likes and comments on a workflow's merged pull request.
 *
 * GitHub has no "have I reacted?" read that is cheaper than listing every
 * reaction, so the id of our own `+1` is cached locally: it is the only way to
 * take the like back, and without it a second click would post a second
 * reaction instead of undoing the first.
 *
 * Reads work anonymously; every write requires the stored token.
 *
 * @module lib/marketplace/engagement
 */

import type { GitHubComment, GitHubReaction } from './github-client'
import { MARKETPLACE_OWNER, MARKETPLACE_REPO, MarketplaceError } from './types'

/** `chrome.storage.local` key for the reaction ids this device created. */
export const REACTIONS_CACHE_KEY = 'marketplaceReactions'

const PAGE_SIZE = 100
/** Comments are discussion, not data: three pages is the whole thread budget. */
const MAX_COMMENT_PAGES = 3

/** The subset of {@link GitHubClient} engagement needs. */
export interface EngagementClient {
  readonly authenticated: boolean
  addReaction(owner: string, repo: string, issueNumber: number): Promise<GitHubReaction>
  deleteReaction(
    owner: string,
    repo: string,
    issueNumber: number,
    reactionId: number,
  ): Promise<void>
  listComments(
    owner: string,
    repo: string,
    issueNumber: number,
    page?: number,
  ): Promise<GitHubComment[]>
  createComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<GitHubComment>
}

/** Local record of the reaction this device added, per issue number. */
export interface ReactionCache {
  get(issueNumber: number): Promise<number | null>
  set(issueNumber: number, reactionId: number | null): Promise<void>
  clear(): Promise<void>
}

export interface ToggleLikeOptions {
  client: EngagementClient
  cache: ReactionCache
  issueNumber: number
  /**
   * Called when GitHub rejects the token. The UI is expected to forget the
   * stored credential and ask for a new one.
   */
  onUnauthorized?: () => void | Promise<void>
}

export interface ToggleLikeResult {
  liked: boolean
}

export interface PostCommentOptions {
  client: EngagementClient
  /** Cleared together with the token when GitHub rejects it. */
  cache: Pick<ReactionCache, 'clear'>
  issueNumber: number
  body: string
  onUnauthorized?: () => void | Promise<void>
}

function requireAuth(client: EngagementClient): void {
  if (!client.authenticated) {
    throw new MarketplaceError('auth-required', 'Connect GitHub to like or comment')
  }
}

async function forgetToken(
  error: unknown,
  cache: Pick<ReactionCache, 'clear'>,
  onUnauthorized: ToggleLikeOptions['onUnauthorized'],
): Promise<void> {
  if (!(error instanceof MarketplaceError) || error.code !== 'unauthorized') return
  await cache.clear()
  await onUnauthorized?.()
}

/** Adds a `+1`, or removes the stored one when this device already liked. */
export async function toggleLike(options: ToggleLikeOptions): Promise<ToggleLikeResult> {
  const { client, cache, issueNumber } = options
  requireAuth(client)
  try {
    const existing = await cache.get(issueNumber)
    if (existing !== null) {
      await client.deleteReaction(MARKETPLACE_OWNER, MARKETPLACE_REPO, issueNumber, existing)
      await cache.set(issueNumber, null)
      return { liked: false }
    }
    const reaction = await client.addReaction(MARKETPLACE_OWNER, MARKETPLACE_REPO, issueNumber)
    await cache.set(issueNumber, reaction.id)
    return { liked: true }
  } catch (error) {
    await forgetToken(error, cache, options.onUnauthorized)
    throw error
  }
}

/** The whole discussion thread, capped at {@link MAX_COMMENT_PAGES} pages. */
export async function listAllComments(
  client: EngagementClient,
  issueNumber: number,
  maxPages = MAX_COMMENT_PAGES,
): Promise<GitHubComment[]> {
  const comments: GitHubComment[] = []
  for (let page = 1; page <= maxPages; page += 1) {
    const chunk = await client.listComments(MARKETPLACE_OWNER, MARKETPLACE_REPO, issueNumber, page)
    comments.push(...chunk)
    if (chunk.length < PAGE_SIZE) break
  }
  return comments
}

/** Posts a comment; empty bodies are refused before any request is made. */
export async function postComment(options: PostCommentOptions): Promise<GitHubComment> {
  const body = options.body.trim()
  if (!body) throw new MarketplaceError('invalid', 'The comment is empty')
  requireAuth(options.client)
  try {
    return await options.client.createComment(
      MARKETPLACE_OWNER,
      MARKETPLACE_REPO,
      options.issueNumber,
      body,
    )
  } catch (error) {
    await forgetToken(error, options.cache, options.onUnauthorized)
    throw error
  }
}

function parseReactionMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) out[key] = value
  }
  return out
}

/** Reaction ids persisted in `chrome.storage.local`; never exported. */
export function chromeReactionCache(): ReactionCache {
  const issueKey = (issueNumber: number): string => String(issueNumber)
  const read = async (): Promise<Record<string, number>> => {
    try {
      const stored = await chrome.storage.local.get(REACTIONS_CACHE_KEY)
      return parseReactionMap(stored[REACTIONS_CACHE_KEY])
    } catch {
      return {}
    }
  }
  const write = async (map: Record<string, number>): Promise<void> => {
    try {
      await chrome.storage.local.set({ [REACTIONS_CACHE_KEY]: map })
    } catch {
      // Losing the id only costs the ability to unlike; never fail the write.
    }
  }

  return {
    async get(issueNumber) {
      const map = await read()
      return map[issueKey(issueNumber)] ?? null
    },
    async set(issueNumber, reactionId) {
      const map = await read()
      if (reactionId === null) delete map[issueKey(issueNumber)]
      else map[issueKey(issueNumber)] = reactionId
      await write(map)
    },
    async clear() {
      try {
        await chrome.storage.local.remove(REACTIONS_CACHE_KEY)
      } catch {
        // Same as above: a stale id is recoverable by the next refresh.
      }
    },
  }
}
