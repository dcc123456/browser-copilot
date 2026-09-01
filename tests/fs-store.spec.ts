import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFileArea,
  getStorageMode,
  keyToPath,
  syncEntriesToFiles,
} from '../src/lib/fs-store'

/**
 * In-memory `chrome.storage.local` double used to verify the mirror/fallback
 * path of the file-backed area.
 */
function makeChromeMock() {
  const store = new Map<string, unknown>()
  const local = {
    get: vi.fn(async (keys: string | string[]) => {
      const wanted = typeof keys === 'string' ? [keys] : keys
      const out: Record<string, unknown> = {}
      for (const key of wanted) {
        if (store.has(key)) out[key] = store.get(key)
      }
      return out
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) store.set(key, value)
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const wanted = typeof keys === 'string' ? [keys] : keys
      for (const key of wanted) store.delete(key)
    }),
  }
  return { store, storage: { local: { get: local.get, set: local.set, remove: local.remove } } }
}

// --- Minimal File System Access API double ------------------------------------

type Node = { kind: 'file'; content: string } | { kind: 'dir'; children: Map<string, Node> }
type FileNode = Extract<Node, { kind: 'file' }>

class FakeFile {
  constructor(private node: Extract<Node, { kind: 'file' }>) {}
  async getFile(): Promise<{ text(): Promise<string> }> {
    return { text: async () => this.node.content }
  }
  async createWritable(): Promise<{ write(text: string): Promise<void>; close(): Promise<void> }> {
    const node = this.node
    return {
      async write(text: string) {
        node.content = String(text)
      },
      async close() {},
    }
  }
}

class FakeDir {
  constructor(private node: Extract<Node, { kind: 'dir' }>) {}
  async getDirectoryHandle(name: string, opts: { create?: boolean }): Promise<FakeDir> {
    const existing = this.node.children.get(name)
    if (existing && existing.kind === 'dir') return new FakeDir(existing)
    if (!opts.create) throw new Error('Not found')
    const dir: Extract<Node, { kind: 'dir' }> = { kind: 'dir', children: new Map() }
    this.node.children.set(name, dir)
    return new FakeDir(dir)
  }
  async getFileHandle(name: string, opts: { create?: boolean }): Promise<FakeFile> {
    const existing = this.node.children.get(name)
    if (existing && existing.kind === 'file') return new FakeFile(existing)
    if (!opts.create) throw new Error('Not found')
    const file: Extract<Node, { kind: 'file' }> = { kind: 'file', content: '' }
    this.node.children.set(name, file)
    return new FakeFile(file)
  }
  async removeEntry(name: string): Promise<void> {
    this.node.children.delete(name)
  }
}

function makeFakeRoot(): { handle: unknown; node: Extract<Node, { kind: 'dir' }> } {
  const root: Extract<Node, { kind: 'dir' }> = { kind: 'dir', children: new Map() }
  return { handle: new FakeDir(root), node: root }
}

/** The `browser-copilot` data subfolder's contents (root.children['browser-copilot']). */
function dataDir(node: Extract<Node, { kind: 'dir' }>): Extract<Node, { kind: 'dir' }> {
  const entry = node.children.get('browser-copilot')
  if (entry && entry.kind === 'dir') return entry
  return { kind: 'dir', children: new Map() }
}

describe('keyToPath', () => {
  it('maps a plain key to a root json file', () => {
    expect(keyToPath('settings')).toEqual(['settings.json'])
  })

  it('maps conversation keys under conversations/', () => {
    expect(keyToPath('conv:abc-123')).toEqual(['conversations', 'abc-123.json'])
  })

  it('sanitizes unsafe characters in file segments', () => {
    expect(keyToPath('conv:my chat#1')).toEqual(['conversations', 'my_chat_1.json'])
  })

  it('maps realistic keys to distinct files (no collisions)', () => {
    const keys = [
      'settings',
      'providers',
      'workflows',
      'scheduledTasks',
      'scheduledTaskRuns',
      'feishuConfig',
      'skills',
      'conversations_meta',
      'conv:a-b',
      'conv:a_b-1',
      'conv:z',
    ]
    const paths = keys.map((key) => keyToPath(key).join('/'))
    expect(new Set(paths).size).toBe(paths.length)
  })
})

describe('createFileArea', () => {
  let chrome: ReturnType<typeof makeChromeMock>

  beforeEach(() => {
    chrome = makeChromeMock()
    vi.stubGlobal('chrome', chrome)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('writes a value to a real file and mirrors it to chrome.storage', async () => {
    const { handle, node } = makeFakeRoot()
    const area = createFileArea(handle as FileSystemDirectoryHandle)

    await area.set({ settings: { locale: 'zh' } })

    const fileEntry = dataDir(node).children.get('settings.json')
    expect(fileEntry).toBeDefined()
    expect(fileEntry?.kind).toBe('file')
    if (fileEntry && fileEntry.kind === 'file') {
      expect(JSON.parse(fileEntry.content)).toEqual({ locale: 'zh' })
    }
    expect(chrome.store.get('settings')).toEqual({ locale: 'zh' })
  })

  it('reads a value back from the file', async () => {
    const { handle } = makeFakeRoot()
    const area = createFileArea(handle as FileSystemDirectoryHandle)

    await area.set({ profile: { name: 'Ada' } })
    const got = await area.get('profile')
    expect(got.profile).toEqual({ name: 'Ada' })
  })

  it('falls back to the chrome mirror when a file is missing', async () => {
    const { handle } = makeFakeRoot()
    const area = createFileArea(handle as FileSystemDirectoryHandle)

    // A key written only to the mirror (e.g. by a service worker before the
    // file handle was granted) must still be readable.
    chrome.store.set('skills', [{ id: 's1', name: 'Scrape' }])
    const got = await area.get('skills')
    expect(got.skills).toEqual([{ id: 's1', name: 'Scrape' }])
  })

  it('removes both the file and the mirror entry', async () => {
    const { handle, node } = makeFakeRoot()
    const area = createFileArea(handle as FileSystemDirectoryHandle)

    await area.set({ settings: { locale: 'en' } })
    expect(dataDir(node).children.has('settings.json')).toBe(true)
    expect(chrome.store.has('settings')).toBe(true)

    await area.remove('settings')
    expect(dataDir(node).children.has('settings.json')).toBe(false)
    expect(chrome.store.has('settings')).toBe(false)
  })

  it('round-trips complex nested data losslessly', async () => {
    const { handle } = makeFakeRoot()
    const area = createFileArea(handle as FileSystemDirectoryHandle)

    const payload = {
      messages: [
        {
          role: 'user',
          content: '你好\n第二行',
          ts: 1_720_000_000_000,
          meta: { ok: true, n: null, arr: [1, 2, { x: 'y' }] },
        },
        { role: 'assistant', content: 'hello', ts: 1_720_000_001_000 },
      ],
      count: 3,
      ratio: 0.5,
      enabled: false,
      empty: '',
      tags: ['a', 'b'],
    }

    await area.set({ 'conv:deep': payload })
    const got = await area.get('conv:deep')
    expect(got['conv:deep']).toEqual(payload)
  })

  it('falls back to the mirror when a file is corrupt', async () => {
    const { handle, node } = makeFakeRoot()
    const area = createFileArea(handle as FileSystemDirectoryHandle)

    // A corrupt file on disk plus a healthy value in the mirror must resolve to
    // the mirror rather than surfacing an unparsable value.
    const dir = dataDir(node)
    dir.children.set('settings.json', { kind: 'file', content: '{not json' })
    chrome.store.set('settings', { locale: 'en' })

    const got = await area.get('settings')
    expect(got.settings).toEqual({ locale: 'en' })
  })
})

describe('syncEntriesToFiles', () => {
  let chrome: ReturnType<typeof makeChromeMock>

  beforeEach(() => {
    chrome = makeChromeMock()
    vi.stubGlobal('chrome', chrome)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('migrates existing browser data to files without loss', async () => {
    const { handle, node } = makeFakeRoot()

    // Simulates the mirror contents right after the user picks a directory:
    // settings, workflows, a conversation transcript, session-only turn state,
    // and a value that is not representable as JSON.
    const mirror: Record<string, unknown> = {
      settings: { locale: 'zh', maxTokens: 4096 },
      workflows: [{ id: 'w1', name: 'Daily' }],
      'conv:abc123': { messages: [{ role: 'user', content: 'hi' }] },
      'turn:abc123': { role: 'user' },
      droppable: undefined,
    }
    await syncEntriesToFiles(mirror, handle as FileSystemDirectoryHandle)

    const dir = dataDir(node)
    expect(JSON.parse((dir.children.get('settings.json') as FileNode).content)).toEqual(
      mirror.settings,
    )
    expect(JSON.parse((dir.children.get('workflows.json') as FileNode).content)).toEqual(
      mirror.workflows,
    )
    const convDir = dir.children.get('conversations') as Extract<Node, { kind: 'dir' }>
    expect(JSON.parse((convDir.children.get('abc123.json') as FileNode).content)).toEqual(
      mirror['conv:abc123'],
    )
    // Session-only state and undefined values must not be persisted as files.
    expect(dir.children.has('turn_abc123.json')).toBe(false)
    expect(dir.children.has('droppable.json')).toBe(false)
  })

  it('is idempotent: re-running leaves the files identical', async () => {
    const { handle, node } = makeFakeRoot()
    const mirror = { settings: { locale: 'zh' }, workflows: [] }

    await syncEntriesToFiles(mirror, handle as FileSystemDirectoryHandle)
    await syncEntriesToFiles(mirror, handle as FileSystemDirectoryHandle)

    const dir = dataDir(node)
    const settingsFile = dir.children.get('settings.json') as FileNode
    expect(JSON.parse(settingsFile.content)).toEqual({ locale: 'zh' })
    expect(JSON.parse((dir.children.get('workflows.json') as FileNode).content)).toEqual([])
  })
})

describe('getStorageMode', () => {
  it('reports browser mode when no directory handle exists', async () => {
    // No indexedDB in the node test environment, so the handle cannot resolve.
    expect(await getStorageMode()).toBe('browser')
  })
})
