/**
 * Guards the release version that ships inside `manifest.json`.
 *
 * The manifest version is what the in-place updater compares a downloaded
 * package against, so the number inside a zip must equal the release tag. A
 * restated literal drifted on v0.6.20/v0.6.21 (a 0.6.19 manifest under
 * 0.6.21-named assets) and every update failed with "not a valid extension
 * archive". `package.json` must stay the only source.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConfigEnv } from 'vite'
import chromeManifestFactory from '../manifest.config'
import { VERSION } from '../scripts/manifest-shared'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

const buildChromeManifest = chromeManifestFactory as unknown as (env: ConfigEnv) => {
  version: string
  version_name?: string
}

describe('release version wiring', () => {
  it('reads the manifest version from package.json instead of restating it', () => {
    expect(VERSION).toBe(pkg.version)
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('stamps both release variants with that exact version', () => {
    const full = buildChromeManifest({ command: 'build', mode: 'production' })
    const lite = buildChromeManifest({ command: 'build', mode: 'no-ocr' })
    expect(full.version).toBe(pkg.version)
    expect(full.version_name).toBeUndefined()
    expect(lite.version).toBe(pkg.version)
    expect(lite.version_name).toBe(`${pkg.version} (no OCR)`)
  })
})
