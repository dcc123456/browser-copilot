/**
 * Manifest facts both releases must agree on, consumed by two assemblers:
 * - the Chrome manifest (`manifest.config.ts`, via crxjs' defineManifest)
 * - the Firefox manifest (`scripts/build-firefox.ts`, written after its build)
 *
 * Only things that MUST stay in lockstep live here. Anything browser-specific
 * (service_worker vs scripts, side_panel vs sidebar_action, the permission
 * deltas) stays in the two assemblers, where the divergences are visible.
 *
 * Kept to erasable TypeScript: `node scripts/build-firefox.ts` runs this file
 * through Node's type stripping, no build step of its own.
 */

/** Release version — single source for both variant manifests. */
export const VERSION = '0.6.5'

export const NAME = 'Browser Copilot'
export const SHORT_NAME = 'BCopilot'
export const DESCRIPTION =
  'A side-panel assistant that can read and act on the page you are looking at. Works with any OpenAI-compatible model.'
export const AUTHOR = 'Browser Copilot'
export const HOMEPAGE_URL = 'https://github.com/dcc123456/browser-copilot'

/** Firefox pins the extension ID so storage and permissions survive reloads of a temporary add-on. */
export const GECKO_ID = 'browser-copilot@dcc123456.github.io'
/** `scripting.executeScript({ world: 'MAIN' })` — the user-JS rung — landed in Firefox 128 (MDN BCD). */
export const STRICT_MIN_VERSION = '128.0'

export const ICONS = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
}

/**
 * Content scripts, in manifest order. `root` is the bundler entry name; the
 * Firefox build emits `<root>.js` as a self-contained IIFE and points the
 * manifest at that file, while Chrome's crxjs build references `source`.
 */
export const CONTENT_SCRIPT_SOURCES = [
  {
    root: 'content-kernel',
    source: 'src/inpage/content-kernel.ts',
    all_frames: true,
    run_at: 'document_idle',
  },
  {
    root: 'floating-button',
    source: 'src/inpage/floating-button.ts',
    all_frames: false,
    run_at: 'document_idle',
  },
]

export const CONTENT_SCRIPT_MATCHES = ['http://*/*', 'https://*/*']

/** The floating button loads the extension icon inside web pages; without this the fetch is blocked. */
export const WEB_ACCESSIBLE_RESOURCES = [
  {
    resources: ['icons/icon-48.png'],
    matches: ['http://*/*', 'https://*/*'],
  },
]

/**
 * Permissions both releases declare. Chrome adds `sidePanel` / `offscreen` /
 * `debugger` on top (each load-bearing, see manifest.config.ts); Firefox drops
 * them because it implements none of the three APIs.
 *
 * Rationale that applies to both:
 * - `scripting` + broad `host_permissions`: reading the current page works by
 *   injecting a one-off read-only script into the tab the user is looking at.
 *   There is no way to read page text without it.
 * - `tabs`: needed to learn the active tab's URL and title, both to decide
 *   whether it can be read at all and to name it in the approval prompt.
 * - `alarms`: powers scheduled tasks (daily/weekday/interval). An alarm is the
 *   only MV3 mechanism that can wake an idle background at a set time, which a
 *   daily 10:00 report fundamentally requires.
 * - `unlimitedStorage`: `chrome.storage.local` hard-rejects a write past
 *   QUOTA_BYTES (10 MB since Chrome 114) with "Resource::kQuotaBytes quota
 *   exceeded" — a string that names an internal constant and tells the user
 *   nothing. With a storage directory configured, user content lives in files
 *   and storage.local only holds extension config plus the narrow
 *   outbox/read-cache fallbacks (see lib/fs-store.ts); without one it holds
 *   everything. Either way ordinary use can reach the cap, where it surfaces
 *   as a failed save. This permission lifts the cap; without it that failure
 *   is a hard write error, not a degraded experience.
 */
export const COMMON_PERMISSIONS = [
  'storage',
  'unlimitedStorage',
  'tabs',
  'scripting',
  'alarms',
  'contextMenus',
  'webNavigation',
  'cookies',
  'downloads',
  'clipboardRead',
]
