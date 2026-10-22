/**
 * Release asset naming and validation.
 *
 * Only the exact asset this build would install is accepted, from the exact
 * GitHub release-download URL prefix. A release missing the variant (for
 * example an OCR-only release for a no-OCR install) is an error, not a silent
 * fallback to a different package.
 *
 * @module lib/update/asset
 */

import {
  UPDATE_ASSET_URL_PREFIX,
  UpdateFailure,
  type UpdateAssetInfo,
  type UpdateVariant,
} from './types'

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/

export function expectedAssetName(version: string, variant: UpdateVariant): string {
  if (variant === 'firefox') return `browser-copilot-${version}-firefox.xpi`
  return `browser-copilot-${version}-${variant}.zip`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Picks and validates the asset named `expectedName` from a release payload.
 * Throws `asset-missing` when the name is absent, `invalid-release` when it is
 * present but its size, digest or URL cannot be trusted.
 */
export function pickReleaseAsset(assets: unknown, expectedName: string): UpdateAssetInfo {
  if (!Array.isArray(assets)) {
    throw new UpdateFailure('invalid-release', 'The latest release has no asset list.')
  }
  const candidate = assets.find(
    (asset): asset is Record<string, unknown> => isRecord(asset) && asset.name === expectedName,
  )
  if (!candidate) {
    throw new UpdateFailure(
      'asset-missing',
      `The latest release does not contain "${expectedName}".`,
    )
  }

  const url = candidate.browser_download_url
  const size = candidate.size
  const rawDigest = candidate.digest
  if (
    typeof url !== 'string' ||
    !url.startsWith(UPDATE_ASSET_URL_PREFIX) ||
    !url.endsWith(`/${expectedName}`)
  ) {
    throw new UpdateFailure('invalid-release', `The asset "${expectedName}" has an untrusted URL.`)
  }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    throw new UpdateFailure('invalid-release', `The asset "${expectedName}" has an invalid size.`)
  }
  if (typeof rawDigest !== 'string') {
    throw new UpdateFailure('invalid-release', `The asset "${expectedName}" has no SHA-256 digest.`)
  }
  const digest = rawDigest.toLowerCase()
  if (!SHA256_DIGEST.test(digest)) {
    throw new UpdateFailure('invalid-release', `The asset "${expectedName}" has an invalid digest.`)
  }

  return { name: expectedName, url, size, digest }
}
