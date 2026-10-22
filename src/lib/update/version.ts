/**
 * Strict `X.Y.Z` version parsing/comparison for the self-updater.
 *
 * Prereleases are intentionally unsupported: a release tagged `v0.7.0-rc.1`
 * must never be written over a stable install. `/releases/latest` already
 * excludes prereleases; this parser is the second line of defence.
 *
 * @module lib/update/version
 */

export interface Semver {
  major: number
  minor: number
  patch: number
}

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** Strips one leading `v` from a tag (`v0.6.7` → `0.6.7`). */
export function normalizeVersion(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed
}

/** Parses `X.Y.Z` (optionally `vX.Y.Z`); `null` for anything else. */
export function parseSemver(raw: string): Semver | null {
  const match = SEMVER_PATTERN.exec(normalizeVersion(raw))
  if (!match) return null
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number]
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  return { major, minor, patch }
}

/** Negative when `left < right`, zero when equal, positive when `left > right`. */
export function compareSemver(left: Semver, right: Semver): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}

/** Whether `latest` is a strictly newer stable version than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const next = parseSemver(latest)
  const installed = parseSemver(current)
  if (!next || !installed) return false
  return compareSemver(next, installed) > 0
}
