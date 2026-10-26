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
import { isAttachmentPath } from './attachments'
import { isValidSlug } from './slug'
import {
  MARKETPLACE_SCHEMA_VERSION,
  MAX_ATTACHMENT_NAME_CHARS,
  MAX_BUNDLE_WORKFLOWS,
  MAX_DESCRIPTION_CHARS,
  MAX_LISTING_SECRETS,
  MAX_LISTING_SECRET_FIELDS,
  MAX_PUBLISH_ATTACHMENT_BYTES,
  MAX_PUBLISH_ATTACHMENTS,
  MAX_SECRET_ID_CHARS,
  MAX_SECRET_KEY_CHARS,
  MAX_SECRET_LABEL_CHARS,
  MAX_SECRET_VALUE_CHARS,
  MAX_TAGS,
  MAX_TAG_CHARS,
  MAX_TITLE_CHARS,
  MarketplaceError,
  type MarketplaceAttachment,
  type MarketplaceDependency,
  type MarketplaceMeta,
  type MarketplaceSecret,
  type MarketplaceSecretField,
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
  attachments?: readonly MarketplaceAttachment[]
  secrets?: readonly MarketplaceSecret[]
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

/** Validates the download list a publisher is about to commit. */
function normalizeAttachments(items: readonly MarketplaceAttachment[]): MarketplaceAttachment[] {
  if (items.length > MAX_PUBLISH_ATTACHMENTS) {
    throw new MarketplaceError(
      'invalid',
      `A listing can carry at most ${MAX_PUBLISH_ATTACHMENTS} attachments`,
    )
  }
  const paths = new Set<string>()
  return items.map((item) => {
    const name = item.name.trim()
    if (!name || name.length > MAX_ATTACHMENT_NAME_CHARS) {
      throw new MarketplaceError('invalid', 'Attachment name is empty or too long')
    }
    if (!isAttachmentPath(item.path)) {
      throw new MarketplaceError('invalid', `Invalid attachment path: ${item.path}`)
    }
    if (!Number.isInteger(item.size) || item.size < 0 || item.size > MAX_PUBLISH_ATTACHMENT_BYTES) {
      throw new MarketplaceError(
        'invalid',
        `Each attachment must be ${MAX_PUBLISH_ATTACHMENT_BYTES / 1024} KB or smaller`,
      )
    }
    if (paths.has(item.path)) {
      throw new MarketplaceError('invalid', 'An attachment is listed twice')
    }
    paths.add(item.path)
    return { name, path: item.path, size: item.size }
  })
}

function normalizeSecrets(items: readonly MarketplaceSecret[]): MarketplaceSecret[] {
  if (items.length > MAX_LISTING_SECRETS) {
    throw new MarketplaceError(
      'invalid',
      `A listing can carry at most ${MAX_LISTING_SECRETS} credentials`,
    )
  }
  const ids = new Set<string>()
  let fieldCount = 0
  return items.map((item) => {
    const id = item.id.trim()
    if (!id || id.length > MAX_SECRET_ID_CHARS) {
      throw new MarketplaceError('invalid', 'Credential id is empty or too long')
    }
    if (ids.has(id)) throw new MarketplaceError('invalid', 'A credential is listed twice')
    ids.add(id)
    const label = item.label.trim()
    if (!label || label.length > MAX_SECRET_LABEL_CHARS) {
      throw new MarketplaceError('invalid', 'Credential label is empty or too long')
    }
    if (item.fields.length === 0) {
      throw new MarketplaceError('invalid', 'A credential has no fields')
    }
    const keys = new Set<string>()
    const fields = item.fields.map((field): MarketplaceSecretField => {
      const key = field.key.trim()
      if (!key || key.length > MAX_SECRET_KEY_CHARS) {
        throw new MarketplaceError('invalid', 'Credential field name is empty or too long')
      }
      const normalizedKey = key.toLowerCase()
      if (keys.has(normalizedKey)) {
        throw new MarketplaceError('invalid', `Credential field "${key}" is listed twice`)
      }
      keys.add(normalizedKey)
      if (field.value.length > MAX_SECRET_VALUE_CHARS) {
        throw new MarketplaceError(
          'invalid',
          `Credential field "${key}" is longer than ${MAX_SECRET_VALUE_CHARS} characters`,
        )
      }
      return { key, value: field.value, ...(field.secret ? { secret: true } : {}) }
    })
    fieldCount += fields.length
    if (fieldCount > MAX_LISTING_SECRET_FIELDS) {
      throw new MarketplaceError(
        'invalid',
        `A listing can carry at most ${MAX_LISTING_SECRET_FIELDS} credential fields`,
      )
    }
    return { id, label, ...(item.url?.trim() ? { url: item.url.trim() } : {}), fields }
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
  const attachments = normalizeAttachments(input.attachments ?? [])
  const secrets = normalizeSecrets(input.secrets ?? [])
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
    ...(attachments.length ? { attachments } : {}),
    ...(secrets.length ? { secrets } : {}),
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
 * Reads the download list. Attachments only affect links on a card, so a bad
 * entry is dropped instead of making the whole listing unusable.
 */
function parseAttachments(raw: unknown): MarketplaceAttachment[] {
  if (!Array.isArray(raw)) return []
  const paths = new Set<string>()
  const attachments: MarketplaceAttachment[] = []
  for (const item of raw) {
    if (attachments.length >= MAX_PUBLISH_ATTACHMENTS) break
    if (!isRecord(item)) continue
    const path = item['path']
    if (typeof path !== 'string' || !isAttachmentPath(path) || paths.has(path)) continue
    const name = item['name']
    if (typeof name !== 'string' || !name.trim()) continue
    const size = item['size']
    if (
      typeof size !== 'number' ||
      !Number.isInteger(size) ||
      size < 0 ||
      size > MAX_PUBLISH_ATTACHMENT_BYTES
    ) {
      continue
    }
    paths.add(path)
    attachments.push({ name: name.trim().slice(0, MAX_ATTACHMENT_NAME_CHARS), path, size })
  }
  return attachments
}

/**
 * Reads the credential list. Credentials decide whether a `get-secret` step can
 * run after apply, but a malformed one must not hide the whole card: bad
 * entries are dropped, exactly like attachments.
 */
function parseSecrets(raw: unknown): MarketplaceSecret[] {
  if (!Array.isArray(raw)) return []
  const secrets: MarketplaceSecret[] = []
  let fieldCount = 0
  for (const item of raw) {
    if (secrets.length >= MAX_LISTING_SECRETS || fieldCount >= MAX_LISTING_SECRET_FIELDS) break
    if (!isRecord(item)) continue
    const id = typeof item['id'] === 'string' ? item['id'].trim() : ''
    if (!id || id.length > MAX_SECRET_ID_CHARS) continue
    if (secrets.some((secret) => secret.id === id)) continue
    const rawLabel = item['label']
    const label =
      typeof rawLabel === 'string' && rawLabel.trim()
        ? rawLabel.trim().slice(0, MAX_SECRET_LABEL_CHARS)
        : id
    const rawUrl = item['url']
    const url = typeof rawUrl === 'string' && rawUrl.trim() ? rawUrl.trim() : undefined
    const fields: MarketplaceSecretField[] = []
    const rawFields = Array.isArray(item['fields']) ? item['fields'] : []
    for (const entry of rawFields) {
      if (fieldCount >= MAX_LISTING_SECRET_FIELDS) break
      if (!isRecord(entry)) continue
      const key = typeof entry['key'] === 'string' ? entry['key'].trim() : ''
      if (!key || key.length > MAX_SECRET_KEY_CHARS) continue
      if (fields.some((field) => field.key.toLowerCase() === key.toLowerCase())) continue
      const value = typeof entry['value'] === 'string' ? entry['value'] : ''
      fields.push({
        key,
        value: value.slice(0, MAX_SECRET_VALUE_CHARS),
        ...(entry['secret'] === true ? { secret: true } : {}),
      })
      fieldCount += 1
    }
    if (fields.length === 0) continue
    secrets.push({ id, label, ...(url ? { url } : {}), fields })
  }
  return secrets
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
  const attachments = parseAttachments(value['attachments'])
  const secrets = parseSecrets(value['secrets'])

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
    ...(attachments.length ? { attachments } : {}),
    ...(secrets.length ? { secrets } : {}),
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

/**
 * True when the published listing moved ahead of the installed copy.
 *
 * Version is the contract, but a listing can be re-published under a number it
 * already used (removed, then added back). The published content hash catches
 * that, so everyone who installed the old bytes still gets the publisher's
 * change. A published version *below* the installed one is never an update: a
 * stale catalog snapshot must not offer a downgrade.
 */
export function needsUpdate(
  remote: MarketplaceMeta,
  local: WorkflowMarketplaceRef | undefined,
): boolean {
  if (!local) return false
  if (remote.slug !== local.slug) return false
  if (remote.version > local.version) return true
  return remote.version === local.version && remote.hash !== local.hash
}
