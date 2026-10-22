/**
 * Choosing the newest downloaded file for `upload-file`'s `latest-download`
 * source.
 *
 * Pure module (no `chrome`, no DOM): the extension executor feeds it download
 * directory entries, the Runner feeds it recorded downloads, and tests feed it
 * plain metadata. Reading the file bytes stays with the caller.
 *
 * @module lib/workflow/latest-file
 */

import { globMatch } from './block-output'
import { extensionForMimeType, mimeTypeForFilename } from './file-artifact'

/** Metadata needed to filter candidates before reading their bytes. */
export interface LatestFileCandidate {
  /** Filename only (never an absolute path). */
  name: string
  /** MIME type when the host knows it. */
  mimeType?: string
  /** Modification time in epoch milliseconds. */
  lastModified: number
  size?: number
}

export interface LatestFileOptions {
  /** Comma-separated accept list: `.xlsx`, `image/*`, `text/csv`, or all. */
  accept?: string
  /** Filename glob (`report-*.xlsx`). Empty or missing means any name. */
  filePattern?: string
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * Match a filename against an `<input accept>`-style list.
 *
 * Extensions win over the MIME type because a downloaded file's reported MIME
 * is frequently `application/octet-stream`. An empty accept list accepts
 * everything, mirroring the file input.
 */
export function matchesAccept(accept: string, name: string, mimeType?: string): boolean {
  const tokens = accept
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
  if (tokens.length === 0) return true

  const extension = extensionOf(name)
  const resolvedMime = (mimeType || mimeTypeForFilename(name) || '').toLowerCase()
  const mimeExtension = resolvedMime ? extensionForMimeType(resolvedMime) : undefined

  return tokens.some((token) => {
    if (token === '*/*' || token === '*') return true
    if (token.startsWith('.')) {
      const wanted = token.slice(1)
      return extension === wanted || (!extension && mimeExtension === wanted)
    }
    if (token.includes('/')) {
      if (token.endsWith('/*')) return resolvedMime.startsWith(token.slice(0, -1))
      return resolvedMime === token
    }
    // Tolerate a bare extension (`xlsx`) in hand-written workflows.
    return extension === token || (!extension && mimeExtension === token)
  })
}

/**
 * Pick the newest candidate that satisfies both filters. Ties break on
 * filename so a run replays deterministically. Returns null when nothing
 * matches; the executor turns that into `UPLOAD_NO_MATCHING_FILE`.
 */
export function pickLatestFile<T extends LatestFileCandidate>(
  candidates: readonly T[],
  options: LatestFileOptions = {},
): T | null {
  const accept = options.accept?.trim() ?? ''
  const pattern = options.filePattern?.trim().toLowerCase() ?? ''

  const matching = candidates.filter((candidate) => {
    if (!matchesAccept(accept, candidate.name, candidate.mimeType)) return false
    if (pattern && !globMatch(pattern, candidate.name.toLowerCase())) return false
    return true
  })
  if (matching.length === 0) return null

  return matching.reduce((newest, candidate) => {
    const candidateTime = Number.isFinite(candidate.lastModified) ? candidate.lastModified : 0
    const newestTime = Number.isFinite(newest.lastModified) ? newest.lastModified : 0
    if (candidateTime > newestTime) return candidate
    if (candidateTime < newestTime) return newest
    return candidate.name.localeCompare(newest.name) < 0 ? candidate : newest
  })
}
