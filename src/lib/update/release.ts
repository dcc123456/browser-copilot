/**
 * Converts the GitHub `/releases/latest` payload into the persisted update
 * state. Chrome-free so the rules can be unit-tested without a browser.
 *
 * @module lib/update/release
 */

import { expectedAssetName, pickReleaseAsset } from './asset'
import {
  UPDATE_RELEASES_URL,
  UpdateFailure,
  type UpdateAssetInfo,
  type UpdateReleaseInfo,
  type UpdateVariant,
} from './types'
import { isNewerVersion, normalizeVersion, parseSemver } from './version'

/** Release bodies are stored in `chrome.storage.local`; keep them bounded. */
const MAX_NOTES_LENGTH = 4000

export interface ParsedLatestRelease {
  release: UpdateReleaseInfo
  /** Present only when `available` is true and the variant asset validates. */
  asset: UpdateAssetInfo | null
  available: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Parses and validates a GitHub release payload.
 *
 * Throws `UpdateFailure` (`invalid-release` or `asset-missing`) rather than
 * returning a half-usable state: a release the updater cannot fully trust is
 * shown as an error, never as an update button.
 */
export function parseLatestRelease(
  payload: unknown,
  options: { currentVersion: string; variant: UpdateVariant },
): ParsedLatestRelease {
  if (!isRecord(payload)) {
    throw new UpdateFailure('invalid-release', 'GitHub returned an unexpected release payload.')
  }
  if (payload.draft === true || payload.prerelease === true) {
    throw new UpdateFailure('invalid-release', 'GitHub returned a draft or prerelease as latest.')
  }

  const tag = readString(payload.tag_name)
  const version = normalizeVersion(tag)
  if (!parseSemver(version)) {
    throw new UpdateFailure(
      'invalid-release',
      `The latest release tag "${tag}" is not a stable X.Y.Z version.`,
    )
  }
  const current = normalizeVersion(options.currentVersion)
  if (!parseSemver(current)) {
    throw new UpdateFailure('invalid-release', `The installed version "${current}" is invalid.`)
  }

  const htmlUrl = readString(payload.html_url)
  if (!htmlUrl.startsWith(`${UPDATE_RELEASES_URL}/`)) {
    throw new UpdateFailure('invalid-release', 'The latest release has an untrusted page URL.')
  }

  const release: UpdateReleaseInfo = {
    version,
    tag,
    name: readString(payload.name) || tag,
    htmlUrl,
    notes: readString(payload.body).trim().slice(0, MAX_NOTES_LENGTH),
    publishedAt: readString(payload.published_at),
  }

  const available = isNewerVersion(version, current)
  const asset = available
    ? pickReleaseAsset(payload.assets, expectedAssetName(version, options.variant))
    : null
  return { release, asset, available }
}
