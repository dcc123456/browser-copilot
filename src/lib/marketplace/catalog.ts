/**
 * The marketplace catalog: which workflows exist and how they are engaged.
 *
 * A public refresh costs three API calls regardless of size — the tree lists
 * every published directory, merged pull requests map a slug to its discussion
 * thread, and the issues list carries the like/comment counts for those same
 * numbers. Workflow bodies and screenshots are read from the raw host, which
 * does not consume API quota. A team refresh skips the two engagement calls
 * (its cards show no likes or comments) and reads metas through the contents
 * API with the team token.
 *
 * The snapshot is cached (memory value + `chrome.storage.local`) for
 * {@link MARKETPLACE_CACHE_TTL_MS}; a failed refresh falls back to the cached
 * snapshot instead of blanking the page.
 *
 * @module lib/marketplace/catalog
 */

import type { GitHubIssue, GitHubPull, GitHubTree, GitHubTreeEntry } from './github-client'
import { hasChromeStorage } from '../fs-outbox'
import { isValidSlug } from './slug'
import { fetchRepoMeta, type RepoReadAccess } from './raw'
import { PUBLIC_REPO, type RepoRef } from './repo'
import { parseMeta } from './meta'
import {
  MARKETPLACE_CACHE_TTL_MS,
  MarketplaceError,
  type MarketplaceCard,
  type MarketplaceMeta,
} from './types'

/** How many published workflows one snapshot may carry. */
export const MAX_CATALOG_ENTRIES = 300

/** Pages fetched per list endpoint; 3 × 100 is the documented display cap. */
export const MAX_CATALOG_PAGES = 3

export const CATALOG_CACHE_KEY = 'marketplaceCatalog'
export const TEAM_CATALOG_CACHE_KEY = 'teamCatalog'
export const CATALOG_LAST_CHECK_KEY = 'marketplaceLastCheck'

const PAGE_SIZE = 100
const META_PATH_RE = /^workflows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/meta\.json$/
const PR_TITLE_RE = /\[wf:([a-z0-9]+(?:-[a-z0-9]+)*)\]/
const SUBMIT_REF_RE = /^submit\/([a-z0-9]+(?:-[a-z0-9]+)*)-\d{12}(?:-\d+)?$/

/** The subset of the GitHub client the catalog reads. */
export interface CatalogClient {
  listTree(owner: string, repo: string, branch: string): Promise<GitHubTree>
  listClosedPulls(owner: string, repo: string, page?: number): Promise<GitHubPull[]>
  listIssues(owner: string, repo: string, page?: number): Promise<GitHubIssue[]>
}

export interface CatalogEntry {
  slug: string
  /** Merged PR that last published this workflow; null for hand-added files. */
  prNumber: number | null
  likes: number
  comments: number
}

export interface CatalogSnapshot {
  fetchedAt: number
  cards: MarketplaceCard[]
  /** True when the repo exceeded the page/entry budget. */
  truncated: boolean
}

export interface CatalogCache {
  load(): Promise<CatalogSnapshot | null>
  save(snapshot: CatalogSnapshot): Promise<void>
}

export interface ReadCatalogDeps {
  client: CatalogClient
  /** Repository to read; defaults to the public marketplace. */
  repo?: RepoRef
  /** Token-backed client used for private repositories' file reads. */
  access?: RepoReadAccess
  /**
   * Whether to read pulls/issues for like and comment counts. The team view
   * turns this off: it has no discussion threads, and the two skipped requests
   * keep a refresh to one tree call plus one meta per workflow.
   */
  includeEngagement?: boolean
  fetchMeta?: (slug: string) => Promise<MarketplaceMeta | null>
  maxPages?: number
  now?: () => number
}

export interface LoadCatalogOptions extends ReadCatalogDeps {
  cache?: CatalogCache
  force?: boolean
  now?: () => number
}

export interface LoadCatalogResult extends CatalogSnapshot {
  fromCache: boolean
  /** Cached result served because the refresh failed. */
  stale: boolean
  /** Why the refresh failed while the cached result was served. */
  staleError?: MarketplaceError
}

/** Slugs from `workflows/<slug>/meta.json` blobs, in tree order. */
export function slugsFromTree(tree: GitHubTreeEntry[]): string[] {
  const slugs: string[] = []
  const seen = new Set<string>()
  for (const entry of tree) {
    if (entry.type !== 'blob') continue
    const match = META_PATH_RE.exec(entry.path)
    const slug = match?.[1]
    if (!slug || !isValidSlug(slug) || seen.has(slug)) continue
    seen.add(slug)
    slugs.push(slug)
  }
  return slugs
}

function slugFromPull(pull: GitHubPull): string | null {
  const fromTitle = PR_TITLE_RE.exec(pull.title)?.[1]
  if (fromTitle && isValidSlug(fromTitle)) return fromTitle
  const fromRef = SUBMIT_REF_RE.exec(pull.head?.ref ?? '')?.[1]
  return fromRef && isValidSlug(fromRef) ? fromRef : null
}

/**
 * Joins the three reads into one entry per published workflow.
 *
 * Only merged PRs count: an open submission has no files on `main` yet. A
 * directory with no merged PR is still listed (the maintainer may have added it
 * by hand), just without a discussion thread.
 */
export function mergeCatalog(
  tree: GitHubTreeEntry[],
  pulls: GitHubPull[],
  issues: GitHubIssue[],
): CatalogEntry[] {
  const entries = new Map<string, CatalogEntry>()
  for (const slug of slugsFromTree(tree)) {
    entries.set(slug, { slug, prNumber: null, likes: 0, comments: 0 })
  }

  const latestPullBySlug = new Map<string, number>()
  for (const pull of pulls) {
    if (!pull.merged_at) continue
    const slug = slugFromPull(pull)
    if (!slug || !entries.has(slug)) continue
    const previous = latestPullBySlug.get(slug) ?? 0
    if (pull.number > previous) latestPullBySlug.set(slug, pull.number)
  }

  const counts = new Map<number, { likes: number; comments: number }>()
  for (const issue of issues) {
    const likes = issue.reactions?.['+1']
    counts.set(issue.number, {
      likes: typeof likes === 'number' && likes > 0 ? likes : 0,
      comments: typeof issue.comments === 'number' && issue.comments > 0 ? issue.comments : 0,
    })
  }

  for (const [slug, prNumber] of latestPullBySlug) {
    const entry = entries.get(slug)!
    const engagement = counts.get(prNumber)
    entries.set(slug, {
      ...entry,
      prNumber,
      likes: engagement?.likes ?? 0,
      comments: engagement?.comments ?? 0,
    })
  }

  return Array.from(entries.values())
}

async function collectPages<T>(
  fetchPage: (page: number) => Promise<T[]>,
  maxPages: number,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = []
  for (let page = 1; page <= maxPages; page += 1) {
    const chunk = await fetchPage(page)
    items.push(...chunk)
    if (chunk.length < PAGE_SIZE) return { items, truncated: false }
  }
  return { items, truncated: true }
}

/**
 * Reads the repository tree, treating an empty repository as an empty catalog.
 *
 * GitHub answers 409 (mapped to `conflict`) while the repo has no commits yet,
 * which is exactly the state the marketplace repo starts in. Reporting it as a
 * load failure would make a newly created marketplace look broken.
 */
async function readTree(client: CatalogClient, repo: RepoRef): Promise<GitHubTree> {
  try {
    return await client.listTree(repo.owner, repo.repo, repo.branch)
  } catch (error) {
    if (error instanceof MarketplaceError && error.code === 'conflict') {
      return { tree: [], truncated: false }
    }
    throw error
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await map(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

/** Reads and joins the catalog. Throws when the API itself is unreachable. */
export async function readCatalog(deps: ReadCatalogDeps): Promise<CatalogSnapshot> {
  const { client } = deps
  const repo = deps.repo ?? PUBLIC_REPO
  const includeEngagement = deps.includeEngagement ?? true
  const maxPages = deps.maxPages ?? MAX_CATALOG_PAGES
  const fetchMeta = deps.fetchMeta ?? ((slug: string) => fetchRepoMeta(repo, slug, deps.access))

  const tree = await readTree(client, repo)
  const pulls = includeEngagement
    ? await collectPages((page) => client.listClosedPulls(repo.owner, repo.repo, page), maxPages)
    : { items: [] as GitHubPull[], truncated: false }
  const issues = includeEngagement
    ? await collectPages((page) => client.listIssues(repo.owner, repo.repo, page), maxPages)
    : { items: [] as GitHubIssue[], truncated: false }

  const entries = mergeCatalog(tree.tree, pulls.items, issues.items)
  const metas = await mapLimit(entries, 8, async (entry) => {
    try {
      return await fetchMeta(entry.slug)
    } catch {
      return null
    }
  })

  const cards: MarketplaceCard[] = []
  entries.forEach((entry, index) => {
    const meta = metas[index]
    if (!meta) return
    cards.push({
      meta,
      prNumber: entry.prNumber,
      likes: entry.likes,
      comments: entry.comments,
    })
  })
  // A tree that lists work but yields no readable meta means the read raced a
  // stale cache or the host is unreachable. Caching that as an empty catalog
  // would hide every published workflow for a full TTL.
  if (entries.length > 0 && cards.length === 0) {
    throw new MarketplaceError('network', 'Could not read any workflow metadata from GitHub')
  }

  cards.sort((a, b) => (Date.parse(b.meta.updatedAt) || 0) - (Date.parse(a.meta.updatedAt) || 0))
  const truncated =
    tree.truncated || pulls.truncated || issues.truncated || cards.length > MAX_CATALOG_ENTRIES

  return {
    fetchedAt: (deps.now ?? Date.now)(),
    cards: cards.slice(0, MAX_CATALOG_ENTRIES),
    truncated,
  }
}

function parseSnapshot(raw: unknown): CatalogSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as { fetchedAt?: unknown; cards?: unknown; truncated?: unknown }
  if (typeof value.fetchedAt !== 'number') return null
  if (!Array.isArray(value.cards)) return null
  const cards: MarketplaceCard[] = []
  for (const item of value.cards) {
    if (!item || typeof item !== 'object') return null
    const card = item as Partial<MarketplaceCard>
    const meta = parseMeta(card.meta)
    if (!meta) return null
    cards.push({
      meta,
      prNumber: typeof card.prNumber === 'number' ? card.prNumber : null,
      likes: typeof card.likes === 'number' ? card.likes : 0,
      comments: typeof card.comments === 'number' ? card.comments : 0,
    })
  }
  return { fetchedAt: value.fetchedAt, cards, truncated: value.truncated === true }
}

/** `chrome.storage.local`-backed cache; the whole snapshot fits in one key. */
export function chromeCatalogCache(key: string = CATALOG_CACHE_KEY): CatalogCache {
  return {
    async load() {
      try {
        const stored = await chrome.storage.local.get(key)
        return parseSnapshot(stored[key])
      } catch {
        return null
      }
    },
    async save(snapshot) {
      try {
        await chrome.storage.local.set({
          [key]: snapshot,
          [CATALOG_LAST_CHECK_KEY]: snapshot.fetchedAt,
        })
      } catch {
        // A cache write must never fail the refresh.
      }
    },
  }
}

/**
 * Drops the cached snapshot so the next marketplace view re-reads GitHub.
 *
 * Used after an auto-merged publish: the workflow is live immediately, and a
 * 2-hour-old snapshot would hide the card the publisher just created.
 */
export async function invalidateCatalogCache(key: string = CATALOG_CACHE_KEY): Promise<void> {
  if (!hasChromeStorage()) return
  await chrome.storage.local.remove(key)
}

/**
 * Cached catalog read with a {@link MARKETPLACE_CACHE_TTL_MS} freshness window.
 *
 * `force` bypasses the window (the explicit refresh button). A failed refresh
 * serves the previous snapshot with `stale: true`; without one it rethrows.
 */
export async function loadCatalog(options: LoadCatalogOptions): Promise<LoadCatalogResult> {
  const now = options.now?.() ?? Date.now()
  const cached = options.cache ? await options.cache.load() : null
  if (cached && !options.force && now - cached.fetchedAt < MARKETPLACE_CACHE_TTL_MS) {
    return { ...cached, fromCache: true, stale: false }
  }

  try {
    const fresh = await readCatalog(options)
    await options.cache?.save(fresh)
    return { ...fresh, fromCache: false, stale: false }
  } catch (error) {
    if (cached) {
      return {
        ...cached,
        fromCache: true,
        stale: true,
        staleError:
          error instanceof MarketplaceError
            ? error
            : new MarketplaceError(
                'network',
                error instanceof Error ? error.message : String(error),
              ),
      }
    }
    throw error
  }
}
