/**
 * Naming and path rules for the optional files published next to a workflow.
 *
 * The display name is whatever the publisher picked (often non-ASCII); the
 * committed file name is a sanitized ASCII stem with a short extension, so a
 * name like `../../etc/passwd` can never escape `attachments/`. Two uploads
 * with the same name are made unique instead of overwriting each other.
 *
 * @module lib/marketplace/attachments
 */

import { slugify } from './slug'

export const ATTACHMENT_DIR = 'attachments'
const MAX_STEM_CHARS = 48
/** A single alphanumeric name, or a stem that starts and ends alphanumeric. */
const ATTACHMENT_PATH_RE = /^attachments\/([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)$/
const MAX_EXT_CHARS = 10

/** Sanitized file name for a user-picked file, extension preserved. */
export function attachmentFile(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  const rawStem = dot > 0 ? base.slice(0, dot) : base
  const rawExt = dot > 0 ? base.slice(dot + 1) : ''
  const stem = slugify(rawStem).slice(0, MAX_STEM_CHARS) || 'file'
  const ext =
    /^[a-z0-9]+$/i.test(rawExt) && rawExt.length <= MAX_EXT_CHARS ? rawExt.toLowerCase() : ''
  return ext ? `${stem}.${ext}` : stem
}

/** Adds a `-2`, `-3`, … suffix until the name is unused, then reserves it. */
export function uniqueAttachmentFile(file: string, taken: Set<string>): string {
  if (!taken.has(file)) {
    taken.add(file)
    return file
  }
  const dot = file.lastIndexOf('.')
  const stem = dot > 0 ? file.slice(0, dot) : file
  const ext = dot > 0 ? file.slice(dot) : ''
  let suffix = 2
  let candidate = `${stem}-${suffix}${ext}`
  while (taken.has(candidate)) {
    suffix += 1
    candidate = `${stem}-${suffix}${ext}`
  }
  taken.add(candidate)
  return candidate
}

/** Workflow-relative path for one attachment file. */
export function attachmentPath(file: string): string {
  return `${ATTACHMENT_DIR}/${file}`
}

/** True when `path` names one file directly inside `attachments/`. */
export function isAttachmentPath(path: string): boolean {
  return ATTACHMENT_PATH_RE.test(path)
}

/** `12 KB` — one decimal only when the file is between 1 and 10 KB. */
export function formatAttachmentSize(bytes: number): string {
  if (bytes <= 0) return '0 KB'
  const kb = bytes / 1024
  if (kb < 1) return '< 1 KB'
  if (kb < 10) return `${Number(kb.toFixed(1))} KB`
  return `${Math.round(kb)} KB`
}
