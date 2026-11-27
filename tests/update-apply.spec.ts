import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyUpdate } from '../src/lib/update/apply'
import { sha256Hex } from '../src/lib/update/sha256'
import type { UpdateAssetInfo, UpdateProgress } from '../src/lib/update/types'
import { buildZip } from './helpers/xlsx-fixture'

// --- Fake File System Access tree ---------------------------------------------

type FileNode = { kind: 'file'; bytes: Uint8Array }
type DirNode = { kind: 'dir'; children: Map<string, FileNode | DirNode> }

function dirNode(): DirNode {
  return { kind: 'dir', children: new Map() }
}

function addFile(root: DirNode, path: string, text: string): void {
  addBytes(root, path, new TextEncoder().encode(text))
}

function addBytes(root: DirNode, path: string, bytes: Uint8Array): void {
  const segments = path.split('/')
  let current = root
  for (const segment of segments.slice(0, -1)) {
    let next = current.children.get(segment)
    if (!next) {
      next = dirNode()
      current.children.set(segment, next)
    }
    if (next.kind !== 'dir') throw new Error(`${segment} is not a directory`)
    current = next
  }
  current.children.set(segments[segments.length - 1]!, { kind: 'file', bytes })
}

function readFile(root: DirNode, path: string): string | null {
  const bytes = readFileBytes(root, path)
  return bytes ? new TextDecoder().decode(bytes) : null
}

function readFileBytes(root: DirNode, path: string): Uint8Array | null {
  const segments = path.split('/')
  let current: DirNode = root
  for (const segment of segments.slice(0, -1)) {
    const next = current.children.get(segment)
    if (!next || next.kind !== 'dir') return null
    current = next
  }
  const file = current.children.get(segments[segments.length - 1]!)
  return file?.kind === 'file' ? file.bytes : null
}

/** Paths whose write() rejects, to exercise the abort-on-failure path. */
const FAIL_WRITE_PATHS = new Set<string>()

class FakeWritable {
  private readonly parts: Uint8Array[] = []

  constructor(
    private readonly node: FileNode,
    private readonly path: string,
    private readonly writes: string[],
    private readonly chunks: Array<{ path: string; size: number }>,
  ) {}

  async write(data: FileSystemWriteChunkType): Promise<void> {
    if (FAIL_WRITE_PATHS.has(this.path)) {
      throw new DOMException('The file could not be written.', 'NotAllowedError')
    }
    const bytes =
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : data instanceof ArrayBuffer
          ? new Uint8Array(data.slice(0))
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
            : null
    if (!bytes) throw new Error('unsupported writable chunk')
    this.writes.push(this.path)
    this.chunks.push({ path: this.path, size: bytes.length })
    this.parts.push(bytes)
  }

  async abort(): Promise<void> {
    // A real abort discards the swap file and leaves the old target untouched.
    this.parts.length = 0
  }

  async close(): Promise<void> {
    const total = this.parts.reduce((sum, part) => sum + part.length, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const part of this.parts) {
      merged.set(part, offset)
      offset += part.length
    }
    this.node.bytes = merged
  }
}

class FakeFileHandle {
  constructor(
    private readonly node: FileNode,
    private readonly fullPath: string,
    private readonly writes: string[],
    private readonly chunks: Array<{ path: string; size: number }>,
  ) {}

  async getFile(): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }> {
    const bytes = this.node.bytes
    return {
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    }
  }

  async createWritable(): Promise<FakeWritable> {
    return new FakeWritable(this.node, this.fullPath, this.writes, this.chunks)
  }
}

class FakeDirectoryHandle {
  constructor(
    private readonly node: DirNode,
    private readonly writes: string[],
    private readonly chunks: Array<{ path: string; size: number }>,
    private readonly prefix = '',
  ) {}

  async queryPermission(): Promise<PermissionState> {
    return 'granted'
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    const fullPath = `${this.prefix}${name}`
    const existing = this.node.children.get(name)
    if (existing?.kind === 'file') {
      return new FakeFileHandle(existing, fullPath, this.writes, this.chunks)
    }
    if (existing) throw new Error(`"${name}" is a directory`)
    if (!options?.create) throw new Error(`"${name}" does not exist`)
    const created: FileNode = { kind: 'file', bytes: new Uint8Array() }
    this.node.children.set(name, created)
    return new FakeFileHandle(created, fullPath, this.writes, this.chunks)
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FakeDirectoryHandle> {
    const existing = this.node.children.get(name)
    if (existing?.kind === 'dir') {
      return new FakeDirectoryHandle(existing, this.writes, this.chunks, `${this.prefix}${name}/`)
    }
    if (existing) throw new Error(`"${name}" is a file`)
    if (!options?.create) throw new Error(`"${name}" does not exist`)
    const created = dirNode()
    this.node.children.set(name, created)
    return new FakeDirectoryHandle(created, this.writes, this.chunks, `${this.prefix}${name}/`)
  }
}

// --- Release fixtures ----------------------------------------------------------

function manifest(version: string, noOcr = false): string {
  return JSON.stringify({
    manifest_version: 3,
    name: 'Browser Copilot',
    version,
    ...(noOcr ? { version_name: `${version} (no OCR)` } : {}),
  })
}

function releaseZip(
  options: { version?: string; noOcr?: boolean; extra?: Record<string, string | Uint8Array> } = {},
): Uint8Array {
  const version = options.version ?? '0.6.8'
  return buildZip({
    'manifest.json': manifest(version, options.noOcr === true),
    'background.js': 'console.log("new")',
    'assets/app.js': 'console.log("app")',
    ...options.extra,
  })
}

async function assetFor(bytes: Uint8Array): Promise<UpdateAssetInfo> {
  return {
    name: 'browser-copilot-0.6.8-ocr.zip',
    url: 'https://github.com/dcc123456/browser-copilot/releases/download/v0.6.8/browser-copilot-0.6.8-ocr.zip',
    size: bytes.length,
    digest: `sha256:${await sha256Hex(bytes)}`,
  }
}

function stubDownload(bytes: Uint8Array, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(bytes as unknown as BodyInit, {
        status,
        headers: { 'content-length': String(bytes.length) },
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function installedFolder(version = '0.6.7'): {
  root: DirNode
  handle: FileSystemDirectoryHandle
  writes: string[]
  chunks: Array<{ path: string; size: number }>
} {
  const root = dirNode()
  addFile(root, 'manifest.json', manifest(version))
  addFile(root, 'background.js', 'console.log("old")')
  const writes: string[] = []
  const chunks: Array<{ path: string; size: number }> = []
  const handle = new FakeDirectoryHandle(
    root,
    writes,
    chunks,
  ) as unknown as FileSystemDirectoryHandle
  return { root, handle, writes, chunks }
}

afterEach(() => {
  FAIL_WRITE_PATHS.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function baseOptions(
  directory: FileSystemDirectoryHandle,
  asset: UpdateAssetInfo,
  overrides: Partial<Parameters<typeof applyUpdate>[0]> = {},
): Promise<Parameters<typeof applyUpdate>[0]> {
  return {
    directory,
    asset,
    currentVersion: '0.6.7',
    targetVersion: '0.6.8',
    expectedName: 'Browser Copilot',
    variant: 'ocr',
    ...overrides,
  }
}

describe('applyUpdate', () => {
  it('verifies, extracts and writes every file, with the manifest last', async () => {
    const { root, handle, writes } = installedFolder()
    const bytes = releaseZip()
    stubDownload(bytes)
    const progress: UpdateProgress[] = []

    const result = await applyUpdate(
      await baseOptions(handle, await assetFor(bytes), {
        onProgress: (entry) => progress.push(entry),
      }),
    )

    expect(result.filesWritten).toBe(2)
    expect(JSON.parse(readFile(root, 'manifest.json')!).version).toBe('0.6.8')
    expect(readFile(root, 'background.js')).toBe('console.log("new")')
    expect(readFile(root, 'assets/app.js')).toBe('console.log("app")')
    expect(writes[writes.length - 1]).toBe('manifest.json')
    // No backup folder is kept: the release is written straight over the old files.
    expect(
      [...root.children.keys()].some((name) => name.startsWith('browser-copilot-backup-')),
    ).toBe(false)
    expect(progress.map((entry) => entry.stage)).toEqual([
      'downloading',
      'downloading',
      'verifying',
      'extracting',
      'writing',
      'writing',
      'done',
    ])
  })

  it('writes stable entry points after every hashed asset', async () => {
    const { handle, writes } = installedFolder()
    const bytes = buildZip({
      'manifest.json': manifest('0.6.8'),
      'service-worker-loader.js': 'import "./assets/app.js"',
      'src/sidepanel/index.html': '<html>new</html>',
      'assets/app.js': 'console.log("app")',
      'background.js': 'console.log("new")',
    })
    stubDownload(bytes)

    await applyUpdate(await baseOptions(handle, await assetFor(bytes)))

    // An interrupted write must not leave the old manifest's bootstrap entry
    // points pointing at missing hashed assets.
    expect(writes).toEqual([
      'assets/app.js',
      'background.js',
      'service-worker-loader.js',
      'src/sidepanel/index.html',
      'manifest.json',
    ])
  })

  it('slices a large file write instead of sending one huge buffer', async () => {
    const MIB = 1024 * 1024
    const content = new Uint8Array(17 * MIB)
    content.fill(2)

    const { root, handle, chunks } = installedFolder()
    addBytes(root, 'tesseract/chi_sim.traineddata.gz', new Uint8Array(17 * MIB).fill(1))
    const bytes = releaseZip({ extra: { 'tesseract/chi_sim.traineddata.gz': content } })
    stubDownload(bytes)

    await applyUpdate(await baseOptions(handle, await assetFor(bytes)))

    expect(readFileBytes(root, 'tesseract/chi_sim.traineddata.gz')!.length).toBe(content.length)

    // A 17MB file used to go out as one write() call; the 0.6.22 OCR update
    // showed that a single buffer that size can fail.
    const largeChunks = chunks.filter((entry) => entry.path === 'tesseract/chi_sim.traineddata.gz')
    expect(largeChunks.length).toBe(Math.ceil(content.length / MIB))
    expect(largeChunks.every((entry) => entry.size <= MIB)).toBe(true)
  })

  it('does not touch the folder when the root manifest is not this installation', async () => {
    const { root, handle, writes } = installedFolder('0.5.0')
    const bytes = releaseZip()
    const fetchMock = stubDownload(bytes)

    await expect(
      applyUpdate(await baseOptions(handle, await assetFor(bytes))),
    ).rejects.toMatchObject({ code: 'folder-invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(writes).toEqual([])
    expect(JSON.parse(readFile(root, 'manifest.json')!).version).toBe('0.5.0')
  })

  it('rejects a digest mismatch before writing anything', async () => {
    const { handle, writes } = installedFolder()
    const bytes = releaseZip()
    stubDownload(bytes)
    const asset = { ...(await assetFor(bytes)), digest: `sha256:${'0'.repeat(64)}` }

    await expect(applyUpdate(await baseOptions(handle, asset))).rejects.toMatchObject({
      code: 'digest-mismatch',
    })
    expect(writes).toEqual([])
  })

  it('rejects an archive with an unsafe path before writing anything', async () => {
    const { handle, writes } = installedFolder()
    const bytes = releaseZip({ extra: { '../escape.js': 'x' } })
    stubDownload(bytes)

    await expect(
      applyUpdate(await baseOptions(handle, await assetFor(bytes))),
    ).rejects.toMatchObject({ code: 'archive-unsafe-path' })
    expect(writes).toEqual([])
  })

  it('rejects a downloaded build of the wrong variant', async () => {
    const { handle, writes } = installedFolder()
    const bytes = releaseZip({ noOcr: true })
    stubDownload(bytes)

    await expect(
      applyUpdate(await baseOptions(handle, await assetFor(bytes))),
    ).rejects.toMatchObject({ code: 'variant-mismatch' })
    expect(writes).toEqual([])
  })

  it('keeps the old manifest when a file write fails midway', async () => {
    const { root, handle, writes } = installedFolder()
    // A file where the archive needs a directory makes parent creation fail.
    addFile(root, 'assets', 'not a directory')
    const bytes = releaseZip()
    stubDownload(bytes)

    await expect(
      applyUpdate(await baseOptions(handle, await assetFor(bytes))),
    ).rejects.toMatchObject({ code: 'write-failed' })
    expect(writes).not.toContain('manifest.json')
    expect(JSON.parse(readFile(root, 'manifest.json')!).version).toBe('0.6.7')
  })

  it('aborts a failed write and leaves the old file in place', async () => {
    const { root, handle } = installedFolder()
    addFile(root, 'service-worker-loader.js', 'old-loader')
    const bytes = releaseZip({ extra: { 'service-worker-loader.js': 'new-loader' } })
    stubDownload(bytes)
    FAIL_WRITE_PATHS.add('service-worker-loader.js')

    await expect(
      applyUpdate(await baseOptions(handle, await assetFor(bytes))),
    ).rejects.toMatchObject({ code: 'write-failed' })

    // There is no backup: aborting must keep the old bootstrap file so the
    // installed build still loads, and the old manifest must still be there.
    expect(readFile(root, 'service-worker-loader.js')).toBe('old-loader')
    expect(JSON.parse(readFile(root, 'manifest.json')!).version).toBe('0.6.7')
  })

  it('reports an incomplete download', async () => {
    const { handle, writes } = installedFolder()
    const bytes = releaseZip()
    stubDownload(bytes)
    const asset = { ...(await assetFor(bytes)), size: bytes.length + 10 }

    await expect(applyUpdate(await baseOptions(handle, asset))).rejects.toMatchObject({
      code: 'download-failed',
    })
    expect(writes).toEqual([])
  })

  it('reports an HTTP failure', async () => {
    const { handle } = installedFolder()
    const bytes = releaseZip()
    stubDownload(bytes, 503)

    await expect(
      applyUpdate(await baseOptions(handle, await assetFor(bytes))),
    ).rejects.toMatchObject({ code: 'download-failed' })
  })

  it('stops before doing anything when the signal is already aborted', async () => {
    const { handle } = installedFolder()
    const bytes = releaseZip()
    const fetchMock = stubDownload(bytes)
    const controller = new AbortController()
    controller.abort()

    await expect(
      applyUpdate(await baseOptions(handle, await assetFor(bytes), { signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'aborted' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
