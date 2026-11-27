/**
 * Opens a GitHub release page from the panel.
 *
 * `chrome.tabs.create` is the extension-safe path (the side panel has no
 * meaningful `window.open` target); the fallback covers hosts where the tabs
 * API is absent.
 *
 * @module sidepanel/update/open-release
 */

import { UPDATE_RELEASES_URL } from '../../lib/update/types'

export function openReleasePage(url: string | undefined): void {
  const target = url || UPDATE_RELEASES_URL
  try {
    void chrome.tabs.create({ url: target })?.catch?.(() => {
      window.open(target, '_blank')
    })
  } catch {
    window.open(target, '_blank')
  }
}

/**
 * Downloads the variant's own package again — the recovery path when an
 * in-place write failed, since the updater keeps no backup. `saveAs` so the
 * user knows where the file landed before copying it over the install folder.
 */
export function downloadReleaseAsset(url: string | undefined): void {
  if (!url) return
  try {
    if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
      void chrome.downloads.download({ url, saveAs: true }).catch(() => undefined)
      return
    }
  } catch {
    // Fall through to the tab fallback below.
  }
  window.open(url, '_blank')
}
