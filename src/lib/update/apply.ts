/**
 * Downloads, verifies and applies one release to the unpacked install folder.
 *
 * Runs only in the side panel (it needs the directory handle and a user
 * gesture). No file is written until the GitHub digest matches and the whole
 * archive validates; the root `manifest.json` is written last, so an aborted
 * or failed write leaves the previous manifest in place.
 *
 * @module lib/update/apply
 */

import { ZipArchive, ZipError, type ZipEntryInfo } from '../zip/zip-archive'
import { verifyInstallDirectory } from './directory'
import { planInstall, splitInstallPath, validateArchiveManifest } from './install-plan'
import { sha256Hex, sha256Matches } from './sha256'
import {
  UpdateApplyError,
  type UpdateAssetInfo,
  type UpdateProgress,
  type UpdateVariant,
} from './types'

/**
 * Files whose paths are stable across releases and are referenced directly by
 * the old install (manifest background/side_panel and the HTML entry points).
 * They point at hashed assets, so they are rewritten only after every asset
 * exists: an interrupted run then still leaves a working old version.
 */
const BOOTSTRAP_LAST = new Set([
  'service-worker-loader.js',
  'src/sidepanel/index.html',
  'src/workflow-editor/index.html',
  'src/offscreen/index.html',
])

function writeOrder(files: readonly ZipEntryInfo[]): ZipEntryInfo[] {
  const isBootstrap = (file: ZipEntryInfo): boolean => BOOTSTRAP_LAST.has(file.name.toLowerCase())
  return [...files.filter((file) => !isBootstrap(file)), ...files.filter(isBootstrap)]
}

const BACKUP_PREFIX = 'browser-copilot-backup-'
/**
 * Deliberately not `manifest.json`: the backup folder lives inside the install
 * folder, and a valid root manifest there could be loaded as a second extension
 * by accident. Restoring is a rename away.
 */
const BACKUP_MANIFEST = 'manifest.json.bak'

export interface ApplyUpdateOptions {
  directory: FileSystemDirectoryHandle
  asset: UpdateAssetInfo
  currentVersion: string
  targetVersion: string
  /** `manifest.name` of the running extension. */
  expectedName: string
  variant: UpdateVariant
  signal?: AbortSignal
  onProgress?: (progress: UpdateProgress) => void
}

export interface ApplyUpdateResult {
  filesWritten: number
  /** Folder inside the install directory holding the files that were replaced. */
  backupFolder: string
}

export async function applyUpdate(options: ApplyUpdateOptions): Promise<ApplyUpdateResult> {
  const { directory, asset, signal, onProgress } = options
  const expectNoOcr = options.variant === 'no-ocr'
  throwIfAborted(signal)

  // Fail before downloading when the folder belongs to another extension or
  // version. The folder manifest is the only reliable proof of identity.
  await verifyInstallDirectory(directory, {
    expectedName: options.expectedName,
    currentVersion: options.currentVersion,
    targetVersion: options.targetVersion,
    expectNoOcr,
  })

  onProgress?.({ stage: 'downloading', loaded: 0, total: asset.size })
  const bytes = await downloadAsset(asset, signal, onProgress)
  throwIfAborted(signal)

  onProgress?.({ stage: 'verifying', loaded: bytes.length, total: bytes.length })
  const actualDigest = await sha256Hex(bytes)
  if (!sha256Matches(actualDigest, asset.digest)) {
    throw new UpdateApplyError(
      'digest-mismatch',
      'The downloaded file does not match the SHA-256 digest published by GitHub.',
    )
  }
  throwIfAborted(signal)

  onProgress?.({ stage: 'extracting', loaded: 0, total: null })
  const archive = openArchive(bytes)
  const plan = planInstall(archive.entries)
  const manifestBytes = await readEntry(archive, plan.manifest.name)
  const manifestText = new TextDecoder('utf-8').decode(manifestBytes)
  validateArchiveManifest(manifestText, {
    expectedName: options.expectedName,
    expectedVersion: options.targetVersion,
    expectNoOcr,
  })

  const files = writeOrder(plan.files)
  const filesTotal = files.length

  // Back up every file this update will replace before touching any of them.
  // A failed backup therefore costs nothing; a failed write still leaves the
  // old version restorable from the backup folder.
  onProgress?.({ stage: 'backing-up', loaded: 0, total: null })
  const backupFolder = backupFolderName(options.currentVersion, Date.now())
  await backupExistingFiles(directory, backupFolder, [...files, plan.manifest], signal)

  for (let index = 0; index < files.length; index += 1) {
    throwIfAborted(signal)
    const file = files[index]!
    const segments = splitInstallPath(file.name)
    if (!segments) {
      throw new UpdateApplyError(
        'archive-unsafe-path',
        `The archive entry "${file.name}" is not a safe relative path.`,
      )
    }
    await writeFile(directory, segments, await readEntry(archive, file.name))
    onProgress?.({
      stage: 'writing',
      loaded: 0,
      total: null,
      filesWritten: index + 1,
      filesTotal,
    })
  }

  throwIfAborted(signal)
  // Last: until this succeeds, Chrome keeps loading the old version.
  await writeFile(directory, ['manifest.json'], manifestBytes)
  onProgress?.({ stage: 'done', loaded: 0, total: null, filesWritten: filesTotal, filesTotal })
  return { filesWritten: filesTotal, backupFolder }
}

function backupFolderName(currentVersion: string, now: number): string {
  const version = currentVersion.replace(/[^0-9A-Za-z._-]/g, '-')
  return `${BACKUP_PREFIX}${version}-${new Date(now).toISOString().replace(/[:.]/g, '-')}`
}

async function backupExistingFiles(
  directory: FileSystemDirectoryHandle,
  backupFolder: string,
  targets: readonly ZipEntryInfo[],
  signal: AbortSignal | undefined,
): Promise<void> {
  let backupRoot: FileSystemDirectoryHandle
  try {
    backupRoot = await directory.getDirectoryHandle(backupFolder, { create: true })
  } catch (error) {
    throw new UpdateApplyError(
      'backup-failed',
      `Could not create "${backupFolder}": ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  for (const target of targets) {
    throwIfAborted(signal)
    const segments = splitInstallPath(target.name)
    if (!segments) continue
    const content = await readExistingFile(directory, segments)
    if (!content) continue
    const backupSegments =
      segments.length === 1 && segments[0] === 'manifest.json' ? [BACKUP_MANIFEST] : segments
    try {
      await writeFile(backupRoot, backupSegments, content)
    } catch (error) {
      throw new UpdateApplyError(
        'backup-failed',
        `Could not back up "${target.name}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

/** Returns the current content, or `null` when the path does not exist. */
async function readExistingFile(
  directory: FileSystemDirectoryHandle,
  segments: readonly string[],
): Promise<Uint8Array | null> {
  let handle: FileSystemFileHandle
  try {
    let parent = directory
    for (const segment of segments.slice(0, -1)) {
      parent = await parent.getDirectoryHandle(segment)
    }
    handle = await parent.getFileHandle(segments[segments.length - 1]!)
  } catch {
    return null
  }
  try {
    const file = await handle.getFile()
    return new Uint8Array(await file.arrayBuffer())
  } catch (error) {
    throw new UpdateApplyError(
      'backup-failed',
      `Could not read "${segments.join('/')}": ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function downloadAsset(
  asset: UpdateAssetInfo,
  signal: AbortSignal | undefined,
  onProgress: ApplyUpdateOptions['onProgress'],
): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetch(asset.url, { cache: 'no-store', signal })
  } catch (error) {
    throw downloadFailure(error, signal)
  }
  if (!response.ok) {
    throw new UpdateApplyError(
      'download-failed',
      `The release download failed with HTTP ${response.status}.`,
    )
  }

  const reportedLength = Number(response.headers.get('content-length') ?? '')
  const total =
    Number.isSafeInteger(reportedLength) && reportedLength > 0 ? reportedLength : asset.size
  if (!response.body) {
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength !== asset.size) {
      throw new UpdateApplyError('download-failed', 'The downloaded file is incomplete.')
    }
    return new Uint8Array(buffer)
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>
    try {
      chunk = await reader.read()
    } catch (error) {
      throw downloadFailure(error, signal)
    }
    if (chunk.done) break
    if (!chunk.value) continue
    chunks.push(chunk.value)
    loaded += chunk.value.length
    onProgress?.({ stage: 'downloading', loaded, total })
  }
  if (loaded !== asset.size) {
    throw new UpdateApplyError(
      'download-failed',
      `Expected ${asset.size} bytes but downloaded ${loaded}.`,
    )
  }
  const output = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

function downloadFailure(error: unknown, signal: AbortSignal | undefined): UpdateApplyError {
  if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
    return new UpdateApplyError('aborted', 'The update was canceled.')
  }
  return new UpdateApplyError(
    'download-failed',
    error instanceof Error ? error.message : 'The release download failed.',
  )
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new UpdateApplyError('aborted', 'The update was canceled.')
  }
}

function openArchive(bytes: Uint8Array): ZipArchive {
  try {
    return ZipArchive.open(bytes)
  } catch (error) {
    if (error instanceof ZipError) {
      throw new UpdateApplyError('archive-invalid', error.message)
    }
    throw error
  }
}

async function readEntry(archive: ZipArchive, name: string): Promise<Uint8Array> {
  try {
    return await archive.read(name)
  } catch (error) {
    if (error instanceof ZipError) {
      throw new UpdateApplyError('archive-invalid', error.message)
    }
    throw error
  }
}

async function writeFile(
  directory: FileSystemDirectoryHandle,
  segments: string[],
  content: Uint8Array,
): Promise<void> {
  const name = segments[segments.length - 1]!
  try {
    let parent = directory
    for (const segment of segments.slice(0, -1)) {
      parent = await parent.getDirectoryHandle(segment, { create: true })
    }
    const handle = await parent.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    try {
      await writable.write(content as unknown as FileSystemWriteChunkType)
    } finally {
      await writable.close()
    }
  } catch (error) {
    throw new UpdateApplyError(
      'write-failed',
      `Could not write "${segments.join('/')}": ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
