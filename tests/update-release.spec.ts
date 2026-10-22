import { describe, expect, it } from 'vitest'
import { expectedAssetName, pickReleaseAsset } from '../src/lib/update/asset'
import { parseLatestRelease } from '../src/lib/update/release'
import { UpdateFailure } from '../src/lib/update/types'

const DIGEST = `sha256:${'a'.repeat(64)}`
const VERSION = '0.6.8'
const TAG = `v${VERSION}`
const RELEASE_URL = `https://github.com/dcc123456/browser-copilot/releases/tag/${TAG}`
const ASSET_BASE = `https://github.com/dcc123456/browser-copilot/releases/download/${TAG}`

function asset(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    size: 1234,
    digest: DIGEST,
    browser_download_url: `${ASSET_BASE}/${name}`,
    ...overrides,
  }
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: TAG,
    name: TAG,
    html_url: RELEASE_URL,
    body: 'Release notes',
    published_at: '2026-10-20T00:00:00Z',
    draft: false,
    prerelease: false,
    assets: [
      asset(`browser-copilot-${VERSION}-ocr.zip`),
      asset(`browser-copilot-${VERSION}-no-ocr.zip`),
      asset(`browser-copilot-${VERSION}-firefox.xpi`, { digest: undefined }),
    ],
    ...overrides,
  }
}

function failureCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof UpdateFailure) return error.code
    throw error
  }
  throw new Error('expected the call to throw')
}

describe('expectedAssetName', () => {
  it('maps each variant to the release naming scheme', () => {
    expect(expectedAssetName('0.6.8', 'ocr')).toBe('browser-copilot-0.6.8-ocr.zip')
    expect(expectedAssetName('0.6.8', 'no-ocr')).toBe('browser-copilot-0.6.8-no-ocr.zip')
    expect(expectedAssetName('0.6.8', 'firefox')).toBe('browser-copilot-0.6.8-firefox.xpi')
  })
})

describe('parseLatestRelease', () => {
  it('selects the OCR asset and normalizes the tag', () => {
    const parsed = parseLatestRelease(payload(), { currentVersion: '0.6.7', variant: 'ocr' })
    expect(parsed.available).toBe(true)
    expect(parsed.release.version).toBe(VERSION)
    expect(parsed.release.tag).toBe(TAG)
    expect(parsed.asset).toEqual({
      name: `browser-copilot-${VERSION}-ocr.zip`,
      size: 1234,
      digest: DIGEST,
      url: `${ASSET_BASE}/browser-copilot-${VERSION}-ocr.zip`,
    })
  })

  it('selects the no-OCR asset independently', () => {
    const parsed = parseLatestRelease(payload(), { currentVersion: '0.6.7', variant: 'no-ocr' })
    expect(parsed.asset?.name).toBe(`browser-copilot-${VERSION}-no-ocr.zip`)
  })

  it('treats the current or an older release as up to date without requiring an asset', () => {
    for (const [currentVersion, tag] of [
      ['0.6.8', TAG],
      ['0.6.9', TAG],
    ] as const) {
      const parsed = parseLatestRelease(payload({ assets: [] }), {
        currentVersion,
        variant: 'ocr',
      })
      expect(parsed.available).toBe(false)
      expect(parsed.asset).toBeNull()
      expect(parsed.release.version).toBe(VERSION)
      expect(parsed.release.tag).toBe(tag)
    }
  })

  it('accepts tags without a leading v', () => {
    const parsed = parseLatestRelease(payload({ tag_name: VERSION }), {
      currentVersion: '0.6.7',
      variant: 'ocr',
    })
    expect(parsed.release.version).toBe(VERSION)
  })

  it('caps stored release notes', () => {
    const parsed = parseLatestRelease(payload({ body: 'x'.repeat(9000) }), {
      currentVersion: '0.6.7',
      variant: 'ocr',
    })
    expect(parsed.release.notes).toHaveLength(4000)
  })

  it('rejects drafts, prereleases and non-stable tags', () => {
    expect(
      failureCode(() =>
        parseLatestRelease(payload({ draft: true }), { currentVersion: '0.6.7', variant: 'ocr' }),
      ),
    ).toBe('invalid-release')
    expect(
      failureCode(() =>
        parseLatestRelease(payload({ prerelease: true }), {
          currentVersion: '0.6.7',
          variant: 'ocr',
        }),
      ),
    ).toBe('invalid-release')
    expect(
      failureCode(() =>
        parseLatestRelease(payload({ tag_name: 'v0.6.8-rc.1' }), {
          currentVersion: '0.6.7',
          variant: 'ocr',
        }),
      ),
    ).toBe('invalid-release')
  })

  it('rejects an untrusted release page URL', () => {
    expect(
      failureCode(() =>
        parseLatestRelease(payload({ html_url: 'https://evil.example/release' }), {
          currentVersion: '0.6.7',
          variant: 'ocr',
        }),
      ),
    ).toBe('invalid-release')
  })

  it('reports a missing variant asset instead of falling back', () => {
    const parsed = payload()
    parsed.assets = [asset(`browser-copilot-${VERSION}-firefox.xpi`)]
    expect(
      failureCode(() => parseLatestRelease(parsed, { currentVersion: '0.6.7', variant: 'ocr' })),
    ).toBe('asset-missing')
  })
})

describe('pickReleaseAsset', () => {
  it('requires a sha256 digest', () => {
    expect(
      failureCode(() => pickReleaseAsset([asset('x.zip', { digest: undefined })], 'x.zip')),
    ).toBe('invalid-release')
    expect(
      failureCode(() => pickReleaseAsset([asset('x.zip', { digest: 'md5:abc' })], 'x.zip')),
    ).toBe('invalid-release')
  })

  it('requires a positive integer size', () => {
    for (const size of [0, -1, 1.5, '12']) {
      expect(failureCode(() => pickReleaseAsset([asset('x.zip', { size })], 'x.zip'))).toBe(
        'invalid-release',
      )
    }
  })

  it('requires the GitHub release-download URL for this exact asset', () => {
    expect(
      failureCode(() =>
        pickReleaseAsset(
          [asset('x.zip', { browser_download_url: 'https://evil.example/x.zip' })],
          'x.zip',
        ),
      ),
    ).toBe('invalid-release')
    expect(
      failureCode(() =>
        pickReleaseAsset(
          [asset('x.zip', { browser_download_url: `${ASSET_BASE}/other.zip` })],
          'x.zip',
        ),
      ),
    ).toBe('invalid-release')
  })

  it('normalizes an uppercase digest', () => {
    const picked = pickReleaseAsset(
      [asset('x.zip', { digest: `sha256:${'A'.repeat(64)}` })],
      'x.zip',
    )
    expect(picked.digest).toBe(`sha256:${'a'.repeat(64)}`)
  })
})
