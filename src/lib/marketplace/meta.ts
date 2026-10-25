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
  MAX_BUNDLE_WORKFLOWS,
  MAX_DESCRIPTION_CHARS,
  MAX_TAGS,
  MAX_TAG_CHARS,
  MAX_TITLE_CHARS,
  MarketplaceError,
  type MarketplaceDependency,
  type MarketplaceMeta,
} from './types'
import { normalizeCategory } from './categories'

const HASH_RE = /^[0-9a-f]{64}$/
const ASSET_RE = /^assets\/[a-z0-9][a-z0-9._-]*$/
const DEPENDENCY_PATH_RE = /^deps\/([a-z0-9][a-z0-9-]*)\.json$/
const AUTHOR_MAX = 64
const DEPENDENCY_ID_MAX = 200

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

/** Workflow-relative file for one bundled dependency. */
export function dependencyPath(file: string): string {
  return `deps/${file}.json`
}

/** The file stem encoded in a bundled dependency path, or null when invalid. */
export function dependencyFile(path: string): string | null {
  const match = DEPENDENCY_PATH_RE.exec(path)
  return match?.[1] ?? null
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
  category: string
  tags?: readonly string[]
  dependencies?: readonly MarketplaceDependency[]
  author: string
  version: number
  hash: string
  imageCount?: number
  videoUrl?: string
  now?: Date
}

/** Validates the bundle list, which apply resolves calls against. */
function normalizeDependencies(items: readonly MarketplaceDependency[]): MarketplaceDependency[] {
  if (items.length > MAX_BUNDLE_WORKFLOWS) {
    throw new MarketplaceError(
      'invalid',
      `A listing can carry at most ${MAX_BUNDLE_WORKFLOWS} called workflows`,
    )
  }
  const ids = new Set<string>()
  const paths = new Set<string>()
  return items.map((item) => {
    const id = item.id.trim()
    if (!id || id.length > DEPENDENCY_ID_MAX) {
      throw new MarketplaceError('invalid', 'Called workflow id is empty or too long')
    }
    const path = item.path
    if (!dependencyFile(path)) {
      throw new MarketplaceError('invalid', `Invalid called workflow path: ${path}`)
    }
    const name = item.name.trim()
    if (!name || name.length > MAX_TITLE_CHARS) {
      throw new MarketplaceError('invalid', 'Called workflow name is empty or too long')
    }
    if (ids.has(id) || paths.has(path)) {
      throw new MarketplaceError('invalid', 'A called workflow is listed twice')
    }
    ids.add(id)
    paths.add(path)
    return { id, name, path }
  })
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
  const category = normalizeCategory(input.category)
  if (!category) {
    throw new MarketplaceError('invalid', 'Workflow category is empty')
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
  const dependencies = normalizeDependencies(input.dependencies ?? [])
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
    category,
    tags: normalizeTags(input.tags ?? []),
    author,
    version: input.version,
    hash: input.hash,
    images,
    ...(dependencies.length ? { dependencies } : {}),
    ...(videoUrl ? { videoUrl } : {}),
    createdAt: stamp,
    updatedAt: stamp,
  }
}

/**
 * Reads the bundle list. Unlike a mistyped category, a broken entry cannot be
 * tolerated: apply would install the parent with calls that resolve to nothing.
 * A missing `name` is only presentation, so it falls back to the id.
 */
function parseDependencies(raw: unknown): MarketplaceDependency[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_BUNDLE_WORKFLOWS) return null
  const ids = new Set<string>()
  const paths = new Set<string>()
  const dependencies: MarketplaceDependency[] = []
  for (const item of raw) {
    if (!isRecord(item)) return null
    const rawId = item['id']
    if (typeof rawId !== 'string' || !rawId.trim() || rawId.length > DEPENDENCY_ID_MAX) return null
    const id = rawId.trim()
    const path = item['path']
    if (typeof path !== 'string' || !dependencyFile(path)) return null
    const rawName = item['name']
    const name =
      typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, MAX_TITLE_CHARS) : id
    if (ids.has(id) || paths.has(path)) return null
    ids.add(id)
    paths.add(path)
    dependencies.push({ id, name, path })
  }
  return dependencies
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
  const category =
    typeof rawCategory === 'string' ? normalizeCategory(rawCategory) || 'other' : 'other'

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
  const dependencies = parseDependencies(value['dependencies'])
  if (dependencies === null) return null

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
    ...(dependencies.length ? { dependencies } : {}),
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
