/**
 * Relative-path rules for the `file-path` source shared by `upload-file` and
 * `parse-excel`.
 *
 * The workflow stores a path INSIDE the authorised download folders, never an
 * absolute host path: the extension cannot read arbitrary files, and storing
 * one would leak the user's folder layout into every exported workflow. The
 * rules live here (chrome-free) so the editor, both executors and the Runner
 * accept exactly the same values.
 *
 * @module lib/workflow/download-file-path
 */

/** Characters Windows forbids in a file name; download paths stay portable. */
const FORBIDDEN_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f]/

/**
 * Normalise a download-relative path to `folder/file.xlsx` form.
 * Returns `null` for anything that could escape the download root.
 */
export function normalizeDownloadFilePath(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Accept Windows-style separators, but always store the portable form.
  const slashed = trimmed.replace(/\\/g, '/')
  // A leading slash is an absolute POSIX path or a UNC share.
  if (slashed.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(slashed)) return null
  const segments = slashed.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null
    if (FORBIDDEN_SEGMENT_CHARS.test(segment)) return null
  }
  return segments.join('/')
}

export interface DownloadPathCandidate {
  /** Path relative to the download root, `/`-separated. */
  relativePath: string
  /** Epoch milliseconds; the newest copy wins when a path repeats. */
  lastModified: number
}

/**
 * Pick the candidate stored at `wantedPath`.
 *
 * `flatBasenameFallback` exists for the headless Runner, which saves every
 * download flat under its suggested file name: a workflow that names
 * `reports/sales.xlsx` still finds `sales.xlsx` there.
 */
export function findDownloadedFileByPath<T extends DownloadPathCandidate>(
  candidates: readonly T[],
  wantedPath: string,
  options: { flatBasenameFallback?: boolean } = {},
): T | null {
  const wanted = normalizeDownloadFilePath(wantedPath)
  if (!wanted) return null
  const exact = candidates.filter(
    (candidate) => normalizeDownloadFilePath(candidate.relativePath) === wanted,
  )
  if (exact.length > 0) return newestCandidate(exact)
  if (!options.flatBasenameFallback) return null
  const basename = wanted.slice(wanted.lastIndexOf('/') + 1)
  const byName = candidates.filter((candidate) => candidate.relativePath === basename)
  return byName.length > 0 ? newestCandidate(byName) : null
}

function newestCandidate<T extends DownloadPathCandidate>(candidates: readonly T[]): T {
  return candidates.reduce((newest, candidate) => {
    const candidateTime = Number.isFinite(candidate.lastModified) ? candidate.lastModified : 0
    const newestTime = Number.isFinite(newest.lastModified) ? newest.lastModified : 0
    if (candidateTime > newestTime) return candidate
    if (candidateTime < newestTime) return newest
    return candidate.relativePath.localeCompare(newest.relativePath) < 0 ? candidate : newest
  })
}
