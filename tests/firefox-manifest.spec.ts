/**
 * Guards the lockstep between the Chrome manifest (manifest.config.ts) and the
 * Firefox manifest (scripts/manifest-firefox.ts): the shared halves must stay
 * equal, and the Firefox side must never grow a key Firefox does not implement
 * (or lose one it needs). See specs/2026-10-15-firefox-support-design.md.
 */
import { describe, expect, it } from 'vitest'
import type { ConfigEnv } from 'vite'
import chromeManifestFactory from '../manifest.config'
import { firefoxManifest } from '../scripts/manifest-firefox'
import {
  COMMON_PERMISSIONS,
  CONTENT_SCRIPT_SOURCES,
  GECKO_ID,
  ICONS,
  STRICT_MIN_VERSION,
  VERSION,
} from '../scripts/manifest-shared'

/** The slice of a manifest both assemblers produce, with the deltas optional. */
interface ManifestShape {
  version: string
  name: string
  short_name: string
  description: string
  homepage_url: string
  author: string
  icons: Record<string, string>
  permissions: string[]
  host_permissions: string[]
  content_security_policy: { extension_pages: string }
  web_accessible_resources: unknown
  background: { service_worker?: string; scripts?: string[]; type?: string }
  content_scripts: Array<{ matches: string[]; js: string[]; all_frames: boolean; run_at: string }>
  minimum_chrome_version?: string
  side_panel?: { default_path: string }
  sidebar_action?: { default_panel: string }
  browser_specific_settings?: { gecko: { id: string; strict_min_version: string } }
}

const chromeManifest = (chromeManifestFactory as unknown as (env: ConfigEnv) => ManifestShape)({
  command: 'build',
  mode: 'build',
})

describe('Firefox manifest', () => {
  const firefox = firefoxManifest() as unknown as ManifestShape

  it('shares the release identity with the Chrome manifest', () => {
    expect(firefox.version).toBe(VERSION)
    expect(firefox.version).toBe(chromeManifest.version)
    expect(firefox.name).toBe(chromeManifest.name)
    expect(firefox.short_name).toBe(chromeManifest.short_name)
    expect(firefox.description).toBe(chromeManifest.description)
    expect(firefox.author).toBe(chromeManifest.author)
    expect(firefox.homepage_url).toBe(chromeManifest.homepage_url)
    expect(firefox.icons).toEqual(ICONS)
    expect(firefox.icons).toEqual(chromeManifest.icons)
  })

  it('keeps the content scripts in lockstep, sources aside', () => {
    const chromeScripts = chromeManifest.content_scripts
    expect(firefox.content_scripts).toHaveLength(CONTENT_SCRIPT_SOURCES.length)
    expect(chromeScripts.map((script) => script.matches)).toEqual(
      firefox.content_scripts.map((script) => script.matches),
    )
    expect(chromeScripts.map((script) => script.all_frames)).toEqual(
      firefox.content_scripts.map((script) => script.all_frames),
    )
    expect(chromeScripts.map((script) => script.run_at)).toEqual(
      firefox.content_scripts.map((script) => script.run_at),
    )
    // Chrome points at the sources; Firefox at the bundled single-file IIFEs.
    expect(chromeScripts.map((script) => script.js[0])).toEqual(
      CONTENT_SCRIPT_SOURCES.map((script) => script.source),
    )
    expect(firefox.content_scripts.map((script) => script.js[0])).toEqual(
      CONTENT_SCRIPT_SOURCES.map((script) => `${script.root}.js`),
    )
  })

  it('declares every common permission and none of the Chrome-only three', () => {
    for (const permission of COMMON_PERMISSIONS) {
      expect(firefox.permissions).toContain(permission)
      expect(chromeManifest.permissions).toContain(permission)
    }
    for (const chromeOnly of ['sidePanel', 'offscreen', 'debugger']) {
      expect(chromeManifest.permissions).toContain(chromeOnly)
      expect(firefox.permissions).not.toContain(chromeOnly)
    }
  })

  it('uses an event page instead of a service worker', () => {
    expect(firefox.background).toEqual({ scripts: ['background.js'], type: 'module' })
    expect(chromeManifest.background.service_worker).toBe('src/background/index.ts')
  })

  it('replaces side_panel with sidebar_action on the same panel page', () => {
    expect(firefox.sidebar_action?.default_panel).toBe('src/sidepanel/index.html')
    expect(chromeManifest.side_panel?.default_path).toBe('src/sidepanel/index.html')
    expect('side_panel' in firefox).toBe(false)
  })

  it('carries the gecko identity instead of minimum_chrome_version', () => {
    expect(firefox.browser_specific_settings?.gecko.id).toBe(GECKO_ID)
    expect(firefox.browser_specific_settings?.gecko.strict_min_version).toBe(STRICT_MIN_VERSION)
    expect(chromeManifest.minimum_chrome_version).toBe('116')
    expect('minimum_chrome_version' in firefox).toBe(false)
  })

  it('narrows host permissions to the parse-safe minimum', () => {
    expect(firefox.host_permissions).toEqual(['<all_urls>'])
    expect(chromeManifest.host_permissions).toEqual(
      expect.arrayContaining(['<all_urls>', 'ws://127.0.0.1/*']),
    )
    expect(firefox.web_accessible_resources).toEqual(chromeManifest.web_accessible_resources)
  })

  it('drops wasm-unsafe-eval from the CSP (the Firefox build ships no OCR)', () => {
    expect(firefox.content_security_policy.extension_pages).not.toContain('wasm-unsafe-eval')
    expect(chromeManifest.content_security_policy.extension_pages).toContain('wasm-unsafe-eval')
  })
})
