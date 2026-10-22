/**
 * Build-variant detection for asset selection.
 *
 * `manifest.config.ts` writes `version_name: "<version> (no OCR)"` for the
 * no-OCR build only, and `manifest-firefox.ts` adds `browser_specific_settings`.
 * Firefox has no File System Access API, so it can never apply an update in
 * place — its variant exists only to pick the `.xpi` link.
 *
 * @module lib/update/variant
 */

import type { UpdateVariant } from './types'

export function variantFromManifest(manifest: {
  version_name?: string
  browser_specific_settings?: unknown
}): UpdateVariant {
  if (manifest.browser_specific_settings) return 'firefox'
  return manifest.version_name?.includes('(no OCR)') ? 'no-ocr' : 'ocr'
}
