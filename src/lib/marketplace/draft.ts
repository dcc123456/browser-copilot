/**
 * Unfinished publish forms, kept per workflow.
 *
 * Closing the publish dialog mid-fill must not throw the description and
 * screenshots away, so the dialog stores them under `marketplaceDrafts` in
 * `chrome.storage.local` (files travel as data URLs — `chrome.storage` holds
 * JSON only) and restores the entry the next time the same workflow's dialog
 * opens. A draft is device-local unpublished working state, like the token and
 * the reaction cache, not library content: it is never written to the user's
 * data folder and expires on its own.
 *
 * @module lib/marketplace/draft
 */

import { hasChromeStorage } from '../fs-outbox'
import { base64ToBytes, bytesToBase64 } from '../base64'
import {
  MAX_ATTACHMENT_NAME_CHARS,
  MAX_CATEGORY_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_PUBLISH_ATTACHMENT_BYTES,
  MAX_PUBLISH_ATTACHMENTS,
  MAX_PUBLISH_IMAGE_BYTES,
  MAX_PUBLISH_IMAGES,
  MAX_TAG_CHARS,
  MAX_TAGS,
  MAX_TITLE_CHARS,
} from './types'

/** Configuration key; also listed in `fs-store.ts`'s CONFIG_KEYS. */
export const MARKETPLACE_DRAFT_KEY = 'marketplaceDrafts'

export const DRAFT_SCHEMA_VERSION = 1

/** Older drafts are dropped on read: an abandoned form should not live forever. */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Newest entries kept; publishing is rare enough that this is generous. */
export const MAX_DRAFTS = 8

const MAX_VIDEO_CHARS = 2048
const MAX_TAGS_INPUT_CHARS = MAX_TAGS * (MAX_TAG_CHARS + 2)
/** Base64 grows bytes by 4/3; the data-URL header plus a margin fits in 128 chars. */
const MAX_IMAGE_DATA_URL_CHARS = Math.ceil((MAX_PUBLISH_IMAGE_BYTES * 4) / 3) + 128
const MAX_ATTACHMENT_DATA_URL_CHARS = Math.ceil((MAX_PUBLISH_ATTACHMENT_BYTES * 4) / 3) + 128

/** One screenshot or attachment, as the JSON-safe form of its bytes. */
export interface DraftFile {
  /** Original file name; screenshots have none. */
  name?: string
  type: string
  dataUrl: string
}

/** Everything the publish form holds, in the shape it is stored. */
export interface PublishDraft {
  schema: typeof DRAFT_SCHEMA_VERSION
  workflowId: string
  title: string
  description: string
  /** Select value: a built-in category slug or the custom-category sentinel. */
  category: string
  customCategory: string
  tags: string
  videoUrl: string
  images: DraftFile[]
  attachments: DraftFile[]
  /** Epoch ms of the last save. */
  savedAt: number
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function parseFile(raw: unknown, maxChars: number, needsName: boolean): DraftFile | null {
  if (!raw || typeof raw !== 'object') return null
  const { name, type, dataUrl } = raw as Record<string, unknown>
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null
  if (dataUrl.length > maxChars) return null
  const media =
    typeof type === 'string' && type ? type : dataUrl.slice('data:'.length, dataUrl.indexOf(';'))
  if (!media) return null
  if (needsName && (typeof name !== 'string' || !name.trim())) return null
  return {
    ...(needsName ? { name: text(name, MAX_ATTACHMENT_NAME_CHARS) } : {}),
    type: media,
    dataUrl,
  }
}

function parseFiles(raw: unknown, max: number, maxChars: number, needsName: boolean): DraftFile[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, max).flatMap((entry) => {
    const file = parseFile(entry, maxChars, needsName)
    return file ? [file] : []
  })
}

/**
 * Validates a stored value. A draft is a convenience, never a trust input:
 * malformed fields fall back to empty strings and bad files are dropped one by
 * one instead of failing the whole restore.
 */
export function parseDraft(raw: unknown, workflowId: string): PublishDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.schema !== DRAFT_SCHEMA_VERSION || value.workflowId !== workflowId) return null
  const savedAt =
    typeof value.savedAt === 'number' && Number.isFinite(value.savedAt) ? value.savedAt : 0
  return {
    schema: DRAFT_SCHEMA_VERSION,
    workflowId,
    title: text(value.title, MAX_TITLE_CHARS),
    description: text(value.description, MAX_DESCRIPTION_CHARS),
    category: text(value.category, MAX_CATEGORY_CHARS) || 'other',
    customCategory: text(value.customCategory, MAX_CATEGORY_CHARS),
    tags: text(value.tags, MAX_TAGS_INPUT_CHARS),
    videoUrl: text(value.videoUrl, MAX_VIDEO_CHARS),
    images: parseFiles(value.images, MAX_PUBLISH_IMAGES, MAX_IMAGE_DATA_URL_CHARS, false),
    attachments: parseFiles(
      value.attachments,
      MAX_PUBLISH_ATTACHMENTS,
      MAX_ATTACHMENT_DATA_URL_CHARS,
      true,
    ),
    savedAt,
  }
}

/** Encodes a selected file for storage; `name` is kept for attachments only. */
export async function blobToDraftFile(blob: Blob, name?: string): Promise<DraftFile> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const type = blob.type || 'application/octet-stream'
  return {
    ...(name ? { name } : {}),
    type,
    dataUrl: `data:${type};base64,${bytesToBase64(bytes)}`,
  }
}

/** Decodes a stored file, or null when its data URL is unreadable. */
export function draftFileToBlob(file: DraftFile): Blob | null {
  const comma = file.dataUrl.indexOf(',')
  if (comma < 0) return null
  try {
    return new Blob([base64ToBytes(file.dataUrl.slice(comma + 1))], { type: file.type })
  } catch {
    return null
  }
}

async function readDrafts(): Promise<Record<string, unknown>> {
  if (!hasChromeStorage()) return {}
  const stored = await chrome.storage.local.get(MARKETPLACE_DRAFT_KEY)
  const raw = stored[MARKETPLACE_DRAFT_KEY]
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

/** The draft saved for this workflow, or null when absent, stale or unreadable. */
export async function loadDraft(
  workflowId: string,
  now = Date.now(),
): Promise<PublishDraft | null> {
  const drafts = await readDrafts()
  const draft = parseDraft(drafts[workflowId], workflowId)
  if (!draft) return null
  if (now - draft.savedAt > DRAFT_TTL_MS) {
    await clearDraft(workflowId)
    return null
  }
  return draft
}

/** Writes one workflow's draft, dropping expired entries and the oldest overflow. */
export async function saveDraft(draft: PublishDraft, now = Date.now()): Promise<void> {
  if (!hasChromeStorage()) return
  const drafts = await readDrafts()
  drafts[draft.workflowId] = draft
  const kept: Record<string, PublishDraft> = {}
  Object.entries(drafts)
    .flatMap(([workflowId, raw]) => {
      const parsed = parseDraft(raw, workflowId)
      return parsed && now - parsed.savedAt <= DRAFT_TTL_MS ? [[workflowId, parsed] as const] : []
    })
    .sort((left, right) => right[1].savedAt - left[1].savedAt)
    .slice(0, MAX_DRAFTS)
    .forEach(([workflowId, parsed]) => {
      kept[workflowId] = parsed
    })
  await chrome.storage.local.set({ [MARKETPLACE_DRAFT_KEY]: kept })
}

/** Forgets one workflow's draft; the storage key disappears with its last entry. */
export async function clearDraft(workflowId: string): Promise<void> {
  if (!hasChromeStorage()) return
  const drafts = await readDrafts()
  if (!(workflowId in drafts)) return
  delete drafts[workflowId]
  if (Object.keys(drafts).length === 0) {
    await chrome.storage.local.remove(MARKETPLACE_DRAFT_KEY)
    return
  }
  await chrome.storage.local.set({ [MARKETPLACE_DRAFT_KEY]: drafts })
}
