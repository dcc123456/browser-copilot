/**
 * The Firefox manifest, assembled from the same shared source as the Chrome one
 * (scripts/manifest-shared.ts) minus everything Firefox does not implement —
 * see specs/2026-10-15-firefox-support-design.md for the evidence behind each
 * difference:
 * - `background.scripts` + `type:"module"` (an event page): Firefox implements
 *   no `background.service_worker`.
 * - `sidebar_action` instead of `side_panel`: Firefox implements no sidePanel.
 * - No `sidePanel` / `offscreen` / `debugger` permissions: none of the three
 *   APIs exists on Firefox.
 * - `host_permissions` is only `<all_urls>`: the ws:// entries of the Chrome
 *   manifest are readability duplicates and Firefox's match-pattern parser need
 *   not accept them.
 * - `browser_specific_settings.gecko` replaces `minimum_chrome_version`.
 *
 * Pure, so tests/firefox-manifest.spec.ts can guard the lockstep with the
 * Chrome manifest without running a build.
 */
import {
  AUTHOR,
  COMMON_PERMISSIONS,
  CONTENT_SCRIPT_MATCHES,
  CONTENT_SCRIPT_SOURCES,
  DESCRIPTION,
  GECKO_ID,
  HOMEPAGE_URL,
  ICONS,
  NAME,
  SHORT_NAME,
  STRICT_MIN_VERSION,
  VERSION,
  WEB_ACCESSIBLE_RESOURCES,
} from './manifest-shared.ts'

/** Built content-script file name, e.g. `content-kernel.js`. */
export function contentScriptFile(root: string): string {
  return `${root}.js`
}

export function firefoxManifest() {
  return {
    manifest_version: 3,
    name: NAME,
    short_name: SHORT_NAME,
    version: VERSION,
    description: DESCRIPTION,
    author: AUTHOR,
    homepage_url: HOMEPAGE_URL,
    // An explicit id keeps the temporary add-on's identity — and therefore its
    // storage.local — stable across reloads in about:debugging.
    browser_specific_settings: {
      gecko: { id: GECKO_ID, strict_min_version: STRICT_MIN_VERSION },
    },
    permissions: [...COMMON_PERMISSIONS],
    host_permissions: ['<all_urls>'],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
    icons: ICONS,
    background: {
      scripts: ['background.js'],
      type: 'module',
    },
    content_scripts: CONTENT_SCRIPT_SOURCES.map((script) => ({
      matches: CONTENT_SCRIPT_MATCHES,
      js: [contentScriptFile(script.root)],
      all_frames: script.all_frames,
      run_at: script.run_at,
    })),
    web_accessible_resources: WEB_ACCESSIBLE_RESOURCES,
    action: {
      default_title: 'Open Browser Copilot',
      default_icon: ICONS,
    },
    // Chrome's side_panel has no Firefox equivalent; sidebar_action is the
    // Firefox panel surface (opened from the toolbar handler via
    // sidebarAction.open(), see src/background/index.ts).
    sidebar_action: {
      default_panel: 'src/sidepanel/index.html',
      default_title: 'Open Browser Copilot',
      default_icon: ICONS,
    },
  }
}
