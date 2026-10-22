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
