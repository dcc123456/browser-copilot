/**
 * `meta.json` — the card record published next to each workflow.
 *
 * Parsing is deliberately strict on identity fields (slug, version, hash) and
 * tolerant on presentation fields (category, tags, timestamps): a card with a
 * mistyped category should still appear, but a card whose identity cannot be
 * trusted must never be applied.
 *
 * @module lib/marketplace/meta
 */

import type { WorkflowMarketplaceRef } from '../workflow/types'
import { isValidSlug } from './slug'
import {
  MARKETPLACE_SCHEMA_VERSION,
  MAX_DESCRIPTION_CHARS,
  MAX_TAGS,
  MAX_TAG_CHARS,
  MAX_TITLE_CHARS,
  MarketplaceError,
  MARKETPLACE_CATEGORIES,
  type MarketplaceCategory,
  type MarketplaceMeta,
} from './types'

const HASH_RE = /^[0-9a-f]{64}$/
const ASSET_RE = /^assets\/[a-z0-9][a-z0-9._-]*$/
const AUTHOR_MAX = 64

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Hex SHA-256 of the exact bytes committed as `workflow.json`. */
export async function workflowHash(json: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Repo-relative paths for one workflow directory. */
export function workflowDir(slug: string): string {
  return `workflows/${slug}`
}

export function metaPath(slug: string): string {
  return `${workflowDir(slug)}/meta.json`
}

export function workflowPath(slug: string): string {
  return `${workflowDir(slug)}/workflow.json`
}

export function assetPath(index: number): string {
  return `assets/${index + 1}.webp`
}

/** Full repo-relative path for one of a workflow's assets. */
export function assetRepoPath(slug: string, asset: string): string {
  return `${workflowDir(slug)}/${asset}`
}

/** Lowercases, trims, de-duplicates and caps tags. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const tag = raw.trim().slice(0, MAX_TAG_CHARS)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

export interface BuildMetaInput {
  slug: string
  title: string
  description: string
  category: MarketplaceCategory
  tags?: readonly string[]
  author: string
  version: number
  hash: string
  imageCount?: number
  videoUrl?: string
  now?: Date
}

/** Builds a validated `meta.json`; throws {@link MarketplaceError} on bad input. */
export function buildMeta(input: BuildMetaInput): MarketplaceMeta {
  if (!isValidSlug(input.slug)) {
    throw new MarketplaceError('invalid', `Invalid workflow slug: ${input.slug}`)
  }
  const title = input.title.trim()
  if (!title || title.length > MAX_TITLE_CHARS) {
    throw new MarketplaceError('invalid', 'Workflow title is empty or too long')
  }
  const description = input.description.trim().slice(0, MAX_DESCRIPTION_CHARS)
  if (!MARKETPLACE_CATEGORIES.includes(input.category)) {
    throw new MarketplaceError('invalid', 'Unknown workflow category')
  }
  const author = input.author.trim()
  if (!author || author.length > AUTHOR_MAX) {
    throw new MarketplaceError('invalid', 'Missing GitHub author')
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new MarketplaceError('invalid', 'Workflow version must be a positive integer')
  }
  if (!HASH_RE.test(input.hash)) {
    throw new MarketplaceError('invalid', 'Workflow hash must be a SHA-256 hex digest')
  }
  const imageCount = input.imageCount ?? 0
  if (!Number.isInteger(imageCount) || imageCount < 0 || imageCount > 3) {
    throw new MarketplaceError('invalid', 'A workflow can publish between 0 and 3 images')
  }
  const images = Array.from({ length: imageCount }, (_, index) => assetPath(index))
  const videoUrl = input.videoUrl?.trim() || undefined
  if (videoUrl && !/^https?:\/\//i.test(videoUrl)) {
    throw new MarketplaceError('invalid', 'Video link must start with http:// or https://')
  }
  const stamp = (input.now ?? new Date()).toISOString()
  return {
    schema: MARKETPLACE_SCHEMA_VERSION,
    slug: input.slug,
    title,
    description,
    category: input.category,
    tags: normalizeTags(input.tags ?? []),
    author,
    version: input.version,
    hash: input.hash,
    images,
    ...(videoUrl ? { videoUrl } : {}),
    createdAt: stamp,
    updatedAt: stamp,
  }
}

/**
 * Parses a remote `meta.json`. Returns `null` when identity fields cannot be
 * trusted; the caller marks the card unavailable instead of guessing.
 */
export function parseMeta(value: unknown): MarketplaceMeta | null {
  if (!isRecord(value)) return null
  if (value['schema'] !== MARKETPLACE_SCHEMA_VERSION) return null
  const slug = value['slug']
  if (typeof slug !== 'string' || !isValidSlug(slug)) return null
  const title = value['title']
  if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_CHARS) return null
  const description = value['description']
  if (typeof description !== 'string' || description.length > MAX_DESCRIPTION_CHARS) return null
  const author = value['author']
  if (typeof author !== 'string' || !author.trim() || author.length > AUTHOR_MAX) return null
  const version = value['version']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null
  const hash = value['hash']
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) return null

  const rawCategory = value['category']
  const category: MarketplaceCategory = MARKETPLACE_CATEGORIES.includes(
    rawCategory as MarketplaceCategory,
  )
    ? (rawCategory as MarketplaceCategory)
    : 'other'

  const rawTags = value['tags']
  const tags = Array.isArray(rawTags)
    ? normalizeTags(rawTags.filter((tag): tag is string => typeof tag === 'string'))
    : []

  const rawImages = value['images']
  const images = Array.isArray(rawImages)
    ? rawImages
        .filter((image): image is string => typeof image === 'string' && ASSET_RE.test(image))
        .slice(0, 3)
    : []

  const rawVideo = value['videoUrl']
  const videoUrl =
    typeof rawVideo === 'string' && /^https?:\/\//i.test(rawVideo) ? rawVideo : undefined

  const createdAt = isoOrEmpty(value['createdAt'])
  const updatedAt = isoOrEmpty(value['updatedAt']) || createdAt

  return {
    schema: MARKETPLACE_SCHEMA_VERSION,
    slug,
    title: title.trim(),
    description,
    category,
    tags,
    author,
    version,
    hash,
    images,
    ...(videoUrl ? { videoUrl } : {}),
    createdAt,
    updatedAt,
  }
}

function isoOrEmpty(value: unknown): string {
  if (typeof value !== 'string') return ''
  const time = Date.parse(value)
  return Number.isNaN(time) ? '' : new Date(time).toISOString()
}

/** Storage guard for `Workflow.marketplace`; invalid refs are dropped on save. */
export function isMarketplaceRef(value: unknown): value is WorkflowMarketplaceRef {
  if (!isRecord(value)) return false
  return (
    typeof value['repo'] === 'string' &&
    value['repo'].length > 0 &&
    typeof value['slug'] === 'string' &&
    isValidSlug(value['slug']) &&
    typeof value['version'] === 'number' &&
    Number.isInteger(value['version']) &&
    value['version'] >= 1 &&
    typeof value['hash'] === 'string' &&
    HASH_RE.test(value['hash']) &&
    typeof value['author'] === 'string' &&
    typeof value['appliedAt'] === 'number'
  )
}

/** True when the published workflow has a version the local copy has not seen. */
export function needsUpdate(
  remote: MarketplaceMeta,
  local: WorkflowMarketplaceRef | undefined,
): boolean {
  if (!local) return false
  return remote.slug === local.slug && remote.version > local.version
}
