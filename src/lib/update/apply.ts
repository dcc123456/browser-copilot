/**
 * Downloads, verifies and applies one release to the unpacked install folder.
 *
 * Runs only in the side panel (it needs the directory handle and a user
 * gesture). No file is written until the GitHub digest matches and the whole
 * archive validates. There is deliberately no backup: files are overwritten in
 * place, each write aborts as a whole when it fails, and the stable entry
 * points plus the root `manifest.json` are written last. A failed update can
 * therefore leave extra hashed assets but never a half-written entry point,
 * and the previous version keeps loading; the dialog offers the release
 * download again for a manual reinstall.
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

/**
 * One whole-file `write()` of a multi-10-MB buffer is not reliable here: the
 * 0.6.22 OCR update failed writing a 20MB `chi_sim.traineddata.gz` in one call
 * while every smaller file of that run was fine. Slice large files so no single
 * call carries a huge buffer.
 */
const WRITE_CHUNK_BYTES = 1024 * 1024

function writeOrder(files: readonly ZipEntryInfo[]): ZipEntryInfo[] {
  const isBootstrap = (file: ZipEntryInfo): boolean => BOOTSTRAP_LAST.has(file.name.toLowerCase())
  return [...files.filter((file) => !isBootstrap(file)), ...files.filter(isBootstrap)]
}

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
  return { filesWritten: filesTotal }
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
      await writeInChunks(writable, content)
    } catch (error) {
      // Abort, don't close: closing commits whatever was written, and a
      // truncated service worker or entry HTML would stop the old version from
      // loading. Aborting keeps the old file — there is no backup to restore.
      await writable.abort().catch(() => undefined)
      throw error
    }
    await writable.close()
  } catch (error) {
    throw new UpdateApplyError(
      'write-failed',
      `Could not write "${segments.join('/')}": ${describeCause(error)}`,
    )
  }
}

async function writeInChunks(
  writable: FileSystemWritableFileStream,
  content: Uint8Array,
): Promise<void> {
  if (content.length <= WRITE_CHUNK_BYTES) {
    await writable.write(content as unknown as FileSystemWriteChunkType)
    return
  }
  for (let offset = 0; offset < content.length; offset += WRITE_CHUNK_BYTES) {
    const end = Math.min(offset + WRITE_CHUNK_BYTES, content.length)
    await writable.write(content.subarray(offset, end) as unknown as FileSystemWriteChunkType)
  }
}

/** `DOMException.message` is often too vague; its `name` is the useful half. */
function describeCause(error: unknown): string {
  if (error instanceof Error) {
    return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message
  }
  return String(error)
}
