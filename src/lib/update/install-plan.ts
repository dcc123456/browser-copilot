/**
 * Validates the contents of a downloaded extension ZIP before anything is
 * written, and validates the folder and manifest the update will replace.
 *
 * These are trust boundaries: the ZIP comes from the network (authenticated by
 * GitHub's digest, but still untrusted input), and the chosen folder comes from
 * a user gesture. Every rule here fails closed — an archive that cannot be
 * installed completely must not be installed partially.
 *
 * @module lib/update/install-plan
 */

import type { ZipEntryInfo } from '../zip/zip-archive'
import { UpdateApplyError } from './types'
import { normalizeVersion } from './version'

const MAX_PATH_LENGTH = 1024
const MAX_SEGMENT_LENGTH = 255
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const DATA_FOLDER = 'browser-copilot'

export interface InstallPlan {
  /** Entries to write, in archive order. Never contains directories or the manifest. */
  files: ZipEntryInfo[]
  /** Root `manifest.json`; written last, after every other file succeeded. */
  manifest: ZipEntryInfo
}

export interface FolderManifestExpectation {
  expectedName: string
  currentVersion: string
  targetVersion: string
  expectNoOcr: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Splits a ZIP entry name into safe path segments, or `null` when the name
 * could escape the destination or hit a platform quirk.
 */
export function splitInstallPath(rawName: string): string[] | null {
  if (!rawName || rawName.length > MAX_PATH_LENGTH) return null
  if (rawName.includes('\\') || rawName.includes(':') || /[\u0000-\u001f\u007f]/.test(rawName)) {
    return null
  }
  if (rawName.startsWith('/')) return null

  const isDirectory = rawName.endsWith('/')
  const body = isDirectory ? rawName.slice(0, -1) : rawName
  const segments = body.split('/')
  if (segments.length === 0) return null
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null
    if (segment.length > MAX_SEGMENT_LENGTH) return null
    if (segment.endsWith(' ') || segment.endsWith('.')) return null
    if (WINDOWS_RESERVED.test(segment)) return null
  }
  if (segments[0]!.toLowerCase() === DATA_FOLDER) return null
  return segments
}

/**
 * Validates every archive path and separates the root manifest from the files
 * that need writing. Throws `archive-unsafe-path`, `archive-duplicate-path` or
 * `archive-invalid`.
 */
export function planInstall(entries: readonly ZipEntryInfo[]): InstallPlan {
  const files: ZipEntryInfo[] = []
  let manifest: ZipEntryInfo | null = null
  const seen = new Set<string>()

  for (const entry of entries) {
    const segments = splitInstallPath(entry.name)
    if (!segments) {
      throw new UpdateApplyError(
        'archive-unsafe-path',
        `The archive entry "${entry.name}" is not a safe relative path.`,
      )
    }
    const key = segments.join('/').toLowerCase()
    if (seen.has(key)) {
      throw new UpdateApplyError(
        'archive-duplicate-path',
        `The archive contains "${entry.name}" more than once.`,
      )
    }
    seen.add(key)

    if (segments.length === 1 && key === 'manifest.json' && !entry.isDirectory) {
      // Chrome reads the manifest from the exact lowercase name; a differently
      // cased sibling is either a duplicate (on a case-insensitive disk) or an
      // install that silently would not load.
      if (segments[0] !== 'manifest.json') {
        throw new UpdateApplyError(
          'archive-invalid',
          'The root manifest must be named exactly "manifest.json".',
        )
      }
      if (manifest) {
        throw new UpdateApplyError('archive-invalid', 'The archive contains two root manifests.')
      }
      manifest = entry
      continue
    }
    if (entry.isDirectory) continue
    files.push(entry)
  }

  if (!manifest) {
    throw new UpdateApplyError('archive-invalid', 'The archive has no root manifest.json.')
  }
  if (files.length === 0) {
    throw new UpdateApplyError('archive-invalid', 'The archive contains no files to install.')
  }
  return { files, manifest }
}

/**
 * Validates the downloaded `manifest.json`: it must describe this exact
 * version and variant, built for MV3, under the expected extension name.
 */
export function validateArchiveManifest(
  text: string,
  options: { expectedName: string; expectedVersion: string; expectNoOcr: boolean },
): void {
  const manifest = parseManifest(text, 'archive-invalid')
  if (manifest.manifest_version !== 3) {
    throw new UpdateApplyError('archive-invalid', 'The downloaded manifest is not MV3.')
  }
  if (manifest.name !== options.expectedName) {
    throw new UpdateApplyError(
      'archive-invalid',
      'The downloaded manifest belongs to a different extension.',
    )
  }
  if (normalizeVersion(String(manifest.version ?? '')) !== options.expectedVersion) {
    throw new UpdateApplyError(
      'archive-invalid',
      'The downloaded manifest version does not match the release.',
    )
  }
  const markedNoOcr =
    typeof manifest.version_name === 'string' && manifest.version_name.includes('(no OCR)')
  if (markedNoOcr !== options.expectNoOcr) {
    throw new UpdateApplyError(
      'variant-mismatch',
      'The downloaded build variant does not match this installation.',
    )
  }
}

/**
 * Validates that the chosen folder is this extension's unpacked install at the
 * version being replaced (or already at the target version after a finished
 * write). A different extension or a different checkout is refused.
 */
export function validateInstallFolderManifest(
  text: string,
  options: FolderManifestExpectation,
): void {
  const manifest = parseManifest(text, 'folder-invalid')
  if (manifest.manifest_version !== 3) {
    throw new UpdateApplyError(
      'folder-invalid',
      'The selected folder is not a Manifest V3 extension.',
    )
  }
  if (manifest.name !== options.expectedName) {
    throw new UpdateApplyError(
      'folder-invalid',
      'The selected folder contains a different extension.',
    )
  }
  const version = normalizeVersion(String(manifest.version ?? ''))
  if (version !== options.currentVersion && version !== options.targetVersion) {
    throw new UpdateApplyError(
      'folder-invalid',
      'The selected folder is not this installation (version mismatch).',
    )
  }
  const markedNoOcr =
    typeof manifest.version_name === 'string' && manifest.version_name.includes('(no OCR)')
  if (markedNoOcr !== options.expectNoOcr) {
    throw new UpdateApplyError(
      'variant-mismatch',
      'The selected folder holds a different build variant.',
    )
  }
}

function parseManifest(
  text: string,
  code: 'archive-invalid' | 'folder-invalid',
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new UpdateApplyError(code, 'The manifest is not valid JSON.')
  }
  if (!isRecord(parsed)) {
    throw new UpdateApplyError(code, 'The manifest is not a JSON object.')
  }
  return parsed
}
