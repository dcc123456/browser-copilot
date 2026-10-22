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

function fileNode(text: string): FileNode {
  return { kind: 'file', bytes: new TextEncoder().encode(text) }
}

function addFile(root: DirNode, path: string, text: string): void {
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
  current.children.set(segments[segments.length - 1]!, fileNode(text))
}

function readFile(root: DirNode, path: string): string | null {
  const segments = path.split('/')
  let current: DirNode = root
  for (const segment of segments.slice(0, -1)) {
    const next = current.children.get(segment)
    if (!next || next.kind !== 'dir') return null
    current = next
  }
  const file = current.children.get(segments[segments.length - 1]!)
  return file?.kind === 'file' ? new TextDecoder().decode(file.bytes) : null
}

class FakeWritable {
  constructor(
    private readonly node: FileNode,
    private readonly path: string,
    private readonly writes: string[],
  ) {}

  async write(data: FileSystemWriteChunkType): Promise<void> {
    this.writes.push(this.path)
    if (typeof data === 'string') {
      this.node.bytes = new TextEncoder().encode(data)
    } else if (data instanceof ArrayBuffer) {
      this.node.bytes = new Uint8Array(data.slice(0))
    } else if (ArrayBuffer.isView(data)) {
      this.node.bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
    } else {
      throw new Error('unsupported writable chunk')
    }
  }

  async close(): Promise<void> {}
}

class FakeFileHandle {
  constructor(
    private readonly node: FileNode,
    private readonly fullPath: string,
    private readonly writes: string[],
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
    return new FakeWritable(this.node, this.fullPath, this.writes)
  }
}

class FakeDirectoryHandle {
  constructor(
    private readonly node: DirNode,
    private readonly writes: string[],
    private readonly prefix = '',
  ) {}

  async queryPermission(): Promise<PermissionState> {
    return 'granted'
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    const fullPath = `${this.prefix}${name}`
    const existing = this.node.children.get(name)
    if (existing?.kind === 'file') return new FakeFileHandle(existing, fullPath, this.writes)
    if (existing) throw new Error(`"${name}" is a directory`)
    if (!options?.create) throw new Error(`"${name}" does not exist`)
    const created: FileNode = { kind: 'file', bytes: new Uint8Array() }
    this.node.children.set(name, created)
    return new FakeFileHandle(created, fullPath, this.writes)
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FakeDirectoryHandle> {
    const existing = this.node.children.get(name)
    if (existing?.kind === 'dir') {
      return new FakeDirectoryHandle(existing, this.writes, `${this.prefix}${name}/`)
    }
    if (existing) throw new Error(`"${name}" is a file`)
    if (!options?.create) throw new Error(`"${name}" does not exist`)
    const created = dirNode()
    this.node.children.set(name, created)
    return new FakeDirectoryHandle(created, this.writes, `${this.prefix}${name}/`)
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
  options: { version?: string; noOcr?: boolean; extra?: Record<string, string> } = {},
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
} {
  const root = dirNode()
  addFile(root, 'manifest.json', manifest(version))
  addFile(root, 'background.js', 'console.log("old")')
  const writes: string[] = []
  const handle = new FakeDirectoryHandle(root, writes) as unknown as FileSystemDirectoryHandle
  return { root, handle, writes }
}

afterEach(() => {
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
    expect(result.backupFolder).toMatch(/^browser-copilot-backup-0\.6\.7-/)
    expect(readFile(root, `${result.backupFolder}/background.js`)).toBe('console.log("old")')
    expect(JSON.parse(readFile(root, `${result.backupFolder}/manifest.json.bak`)!).version).toBe(
      '0.6.7',
    )
    // The backup must never be loadable as a second extension.
    expect(readFile(root, `${result.backupFolder}/manifest.json`)).toBeNull()
    // Only replaced files are backed up, not files that the release adds.
    expect(readFile(root, `${result.backupFolder}/assets/app.js`)).toBeNull()
    expect(progress.map((entry) => entry.stage)).toEqual([
      'downloading',
      'downloading',
      'verifying',
      'extracting',
      'backing-up',
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

    const result = await applyUpdate(await baseOptions(handle, await assetFor(bytes)))

    // An interrupted write must not leave the old manifest's bootstrap entry
    // points pointing at missing hashed assets.
    const installWrites = writes.filter((path) => !path.startsWith(`${result.backupFolder}/`))
    expect(installWrites).toEqual([
      'assets/app.js',
      'background.js',
      'service-worker-loader.js',
      'src/sidepanel/index.html',
      'manifest.json',
    ])
    // Backups all happen before the first install write.
    expect(writes.slice(0, writes.indexOf('assets/app.js'))).toEqual([
      `${result.backupFolder}/background.js`,
      `${result.backupFolder}/manifest.json.bak`,
    ])
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

  it('stops before overwriting when the backup folder cannot be created', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-22T10:00:00.000Z'))
    const { root, handle, writes } = installedFolder()
    // A file where the timestamped backup folder needs to go.
    addFile(root, 'browser-copilot-backup-0.6.7-2026-10-22T10-00-00-000Z', 'in the way')
    const bytes = releaseZip()
    stubDownload(bytes)

    await expect(
      applyUpdate(await baseOptions(handle, await assetFor(bytes))),
    ).rejects.toMatchObject({ code: 'backup-failed' })
    expect(writes).toEqual([])
    expect(JSON.parse(readFile(root, 'manifest.json')!).version).toBe('0.6.7')
    expect(readFile(root, 'background.js')).toBe('console.log("old")')
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
