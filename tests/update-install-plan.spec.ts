import { describe, expect, it } from 'vitest'
import type { ZipEntryInfo } from '../src/lib/zip/zip-archive'
import {
  planInstall,
  splitInstallPath,
  validateArchiveManifest,
  validateInstallFolderManifest,
} from '../src/lib/update/install-plan'
import { UpdateApplyError } from '../src/lib/update/types'

const MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: 'Browser Copilot',
  version: '0.6.8',
})

function entry(name: string, overrides: Partial<ZipEntryInfo> = {}): ZipEntryInfo {
  return {
    name,
    isDirectory: name.endsWith('/'),
    method: 8,
    compressedSize: 10,
    uncompressedSize: 10,
    encrypted: false,
    ...overrides,
  }
}

function applyCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof UpdateApplyError) return error.code
    throw error
  }
  throw new Error('expected the call to throw')
}

describe('splitInstallPath', () => {
  it('splits normal relative paths and directory records', () => {
    expect(splitInstallPath('assets/index-abc.js')).toEqual(['assets', 'index-abc.js'])
    expect(splitInstallPath('manifest.json')).toEqual(['manifest.json'])
    expect(splitInstallPath('assets/')).toEqual(['assets'])
  })

  it.each([
    '',
    '/etc/passwd',
    '../outside.js',
    'assets/../../outside.js',
    'assets/./index.js',
    'assets//index.js',
    'assets\\index.js',
    'C:/windows.js',
    'stream:name',
    'assets/bad\u0000name.js',
    'assets/trailing /index.js',
    'assets/trailing./index.js',
    'con',
    'assets/LPT1.js',
    'browser-copilot/data.json',
    'a'.repeat(256),
  ])('rejects unsafe path %j', (name) => {
    expect(splitInstallPath(name)).toBeNull()
  })

  it('rejects container-level edge cases', () => {
    expect(splitInstallPath('/')).toBeNull()
    expect(splitInstallPath('x'.repeat(1025))).toBeNull()
  })
})

describe('planInstall', () => {
  it('separates files from directories and the manifest', () => {
    const plan = planInstall([
      entry('manifest.json'),
      entry('assets/'),
      entry('assets/index.js'),
      entry('background.js'),
    ])
    expect(plan.manifest.name).toBe('manifest.json')
    expect(plan.files.map((file) => file.name)).toEqual(['assets/index.js', 'background.js'])
  })

  it('rejects archives without a root manifest', () => {
    expect(applyCode(() => planInstall([entry('assets/index.js')]))).toBe('archive-invalid')
  })

  it('rejects a mis-cased root manifest', () => {
    expect(applyCode(() => planInstall([entry('Manifest.json'), entry('index.js')]))).toBe(
      'archive-invalid',
    )
  })

  it('rejects duplicate paths regardless of case', () => {
    expect(
      applyCode(() => planInstall([entry('manifest.json'), entry('a.js'), entry('A.JS')])),
    ).toBe('archive-duplicate-path')
  })

  it('rejects a file that collides with a directory record', () => {
    expect(
      applyCode(() => planInstall([entry('manifest.json'), entry('assets/'), entry('assets')])),
    ).toBe('archive-duplicate-path')
  })

  it('rejects an archive with only a manifest', () => {
    expect(applyCode(() => planInstall([entry('manifest.json')]))).toBe('archive-invalid')
  })

  it('rejects an unsafe sibling path', () => {
    expect(applyCode(() => planInstall([entry('manifest.json'), entry('../escape.js')]))).toBe(
      'archive-unsafe-path',
    )
  })
})

describe('validateArchiveManifest', () => {
  const expectOcr = {
    expectedName: 'Browser Copilot',
    expectedVersion: '0.6.8',
    expectNoOcr: false,
  }

  it('accepts the expected OCR build manifest', () => {
    expect(() => validateArchiveManifest(MANIFEST, expectOcr)).not.toThrow()
  })

  it('accepts a no-OCR manifest only for a no-OCR install', () => {
    const noOcr = JSON.stringify({
      ...JSON.parse(MANIFEST),
      version_name: '0.6.8 (no OCR)',
    })
    expect(() => validateArchiveManifest(noOcr, { ...expectOcr, expectNoOcr: true })).not.toThrow()
    expect(applyCode(() => validateArchiveManifest(noOcr, expectOcr))).toBe('variant-mismatch')
    expect(
      applyCode(() => validateArchiveManifest(MANIFEST, { ...expectOcr, expectNoOcr: true })),
    ).toBe('variant-mismatch')
  })

  it('rejects a different extension, version or manifest version', () => {
    expect(
      applyCode(() =>
        validateArchiveManifest(
          JSON.stringify({ manifest_version: 3, name: 'Other', version: '0.6.8' }),
          expectOcr,
        ),
      ),
    ).toBe('archive-invalid')
    expect(
      applyCode(() =>
        validateArchiveManifest(
          JSON.stringify({ manifest_version: 3, name: 'Browser Copilot', version: '0.6.7' }),
          expectOcr,
        ),
      ),
    ).toBe('archive-invalid')
    expect(
      applyCode(() =>
        validateArchiveManifest(
          JSON.stringify({ manifest_version: 2, name: 'Browser Copilot', version: '0.6.8' }),
          expectOcr,
        ),
      ),
    ).toBe('archive-invalid')
  })

  it('rejects malformed JSON and non-object documents', () => {
    expect(applyCode(() => validateArchiveManifest('{', expectOcr))).toBe('archive-invalid')
    expect(applyCode(() => validateArchiveManifest('[]', expectOcr))).toBe('archive-invalid')
  })
})

describe('validateInstallFolderManifest', () => {
  const expectation = {
    expectedName: 'Browser Copilot',
    currentVersion: '0.6.7',
    targetVersion: '0.6.8',
    expectNoOcr: false,
  }

  it('accepts the folder at the version being replaced or already updated', () => {
    expect(() => validateInstallFolderManifest(MANIFEST, expectation)).not.toThrow()
    expect(() =>
      validateInstallFolderManifest(
        JSON.stringify({ manifest_version: 3, name: 'Browser Copilot', version: '0.6.7' }),
        expectation,
      ),
    ).not.toThrow()
  })

  it('refuses a different extension, an unrelated version or a different variant', () => {
    expect(
      applyCode(() =>
        validateInstallFolderManifest(
          JSON.stringify({ manifest_version: 3, name: 'Other', version: '0.6.7' }),
          expectation,
        ),
      ),
    ).toBe('folder-invalid')
    expect(
      applyCode(() =>
        validateInstallFolderManifest(
          JSON.stringify({ manifest_version: 3, name: 'Browser Copilot', version: '0.5.0' }),
          expectation,
        ),
      ),
    ).toBe('folder-invalid')
    expect(
      applyCode(() =>
        validateInstallFolderManifest(
          JSON.stringify({
            manifest_version: 3,
            name: 'Browser Copilot',
            version: '0.6.7',
            version_name: '0.6.7 (no OCR)',
          }),
          expectation,
        ),
      ),
    ).toBe('variant-mismatch')
  })
})
