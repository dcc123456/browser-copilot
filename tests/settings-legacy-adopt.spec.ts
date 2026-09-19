import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureSchema, getSettings, normalizeStoredSettings } from '../src/lib/storage'
import { FsDirectory, resetStorageCache } from '../src/lib/fs-store'
import type { ProviderProfile } from '../src/lib/providers'

/**
 * Regression tests for the provider-configuration loss.
 *
 * Versions before the config/data split migrated `settings` (which holds the
 * provider profiles) into the storage directory. A schema bootstrap that ran
 * while the directory handle was unavailable (extension reload / browser
 * restart — the permission resets to 'prompt' and a service worker cannot
 * re-grant) fabricated pristine defaults over the gap; the read path only
 * adopts legacy files for ABSENT keys, so the real providers stayed shadowed
 * forever. `ensureSchema` must not fabricate over the gap, and `getSettings`
 * must adopt the legacy file when the stored value carries no user data.
 */

function makeChromeMock() {
  const store = new Map<string, unknown>()
  const local = {
    get: vi.fn(async (keys: string | string[] | null) => {
      const wanted =
        keys === null ? [...store.keys()] : typeof keys === 'string' ? [keys] : keys
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

// --- Minimal File System Access double (same shape as fs-store.spec.ts) -------

type Node = { kind: 'file'; content: string } | { kind: 'dir'; children: Map<string, Node> }

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
    if (!opts?.create) throw new Error('Not found')
    const dir: Extract<Node, { kind: 'dir' }> = { kind: 'dir', children: new Map() }
    this.node.children.set(name, dir)
    return new FakeDir(dir)
  }
  async getFileHandle(name: string, opts: { create?: boolean }): Promise<FakeFile> {
    const existing = this.node.children.get(name)
    if (existing && existing.kind === 'file') return new FakeFile(existing)
    if (!opts?.create) throw new Error('Not found')
    const file: Extract<Node, { kind: 'file' }> = { kind: 'file', content: '' }
    this.node.children.set(name, file)
    return new FakeFile(file)
  }
}

function makeFakeRoot(): { handle: FakeDir; node: Extract<Node, { kind: 'dir' }> } {
  const root: Extract<Node, { kind: 'dir' }> = { kind: 'dir', children: new Map() }
  return { handle: new FakeDir(root), node: root }
}

function dataDir(node: Extract<Node, { kind: 'dir' }>): Extract<Node, { kind: 'dir' }> {
  const entry = node.children.get('browser-copilot')
  if (entry && entry.kind === 'dir') return entry
  return { kind: 'dir', children: new Map() }
}

function stubIndexedDb(stored: FakeDir, permission: PermissionState): void {
  const handle = {
    name: 'picked',
    queryPermission: async (): Promise<PermissionState> => permission,
    getDirectoryHandle: (name: string, opts: { create?: boolean }) =>
      stored.getDirectoryHandle(name, opts),
    getFileHandle: (name: string, opts: { create?: boolean }) => stored.getFileHandle(name, opts),
  }
  const db = {
    transaction: () => ({
      objectStore: () => ({
        get: () => {
          const request: { result: unknown; onsuccess: null | (() => void) } = {
            result: handle,
            onsuccess: null,
          }
          setTimeout(() => request.onsuccess?.(), 0)
          return request
        },
      }),
    }),
  }
  vi.stubGlobal('indexedDB', {
    open: () => {
      const request: { result: unknown; onsuccess: null | (() => void) } = {
        result: db,
        onsuccess: null,
      }
      setTimeout(() => request.onsuccess?.(), 0)
      return request
    },
  })
}

const PROVIDER: ProviderProfile = {
  id: 'p1',
  presetId: '',
  label: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-test',
  model: 'deepseek-chat',
}

describe('legacy settings adoption', () => {
  let chrome: ReturnType<typeof makeChromeMock>

  beforeEach(() => {
    chrome = makeChromeMock()
    vi.stubGlobal('chrome', chrome)
    resetStorageCache()
  })

  afterEach(() => {
    resetStorageCache()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('recovers providers from the legacy file when browser storage holds fabricated defaults', async () => {
    const { handle, node } = makeFakeRoot()
    stubIndexedDb(handle, 'granted')
    // The pre-split design put the real settings into the directory…
    const fs = new FsDirectory(handle as unknown as FileSystemDirectoryHandle)
    await fs.writeText(
      ['settings.json'],
      JSON.stringify({ providers: [PROVIDER], activeProviderId: 'p1', locale: 'zh' }),
    )
    // …and a schema bootstrap that ran while the handle was down fabricated
    // pristine defaults into browser storage, shadowing the file.
    chrome.store.set('settings', normalizeStoredSettings(undefined))

    const settings = await getSettings()

    expect(settings.providers).toHaveLength(1)
    expect(settings.providers[0]?.id).toBe('p1')
    // The repair sticks: browser storage now holds the adopted value.
    const adopted = chrome.store.get('settings') as { providers: ProviderProfile[] }
    expect(adopted.providers).toHaveLength(1)
    expect(dataDir(node).children.has('settings.json')).toBe(true)
  })

  it('recovers settings from the legacy file when browser storage has none', async () => {
    const { handle } = makeFakeRoot()
    stubIndexedDb(handle, 'granted')
    const fs = new FsDirectory(handle as unknown as FileSystemDirectoryHandle)
    await fs.writeText(['settings.json'], JSON.stringify({ providers: [PROVIDER] }))

    const settings = await getSettings()

    expect(settings.providers).toHaveLength(1)
    expect(chrome.store.has('settings')).toBe(true)
  })

  it('keeps real browser settings and ignores the legacy file', async () => {
    const { handle } = makeFakeRoot()
    stubIndexedDb(handle, 'granted')
    const fs = new FsDirectory(handle as unknown as FileSystemDirectoryHandle)
    await fs.writeText(
      ['settings.json'],
      JSON.stringify({ providers: [{ ...PROVIDER, id: 'old' }] }),
    )
    const current = { ...normalizeStoredSettings(undefined), providers: [PROVIDER] }
    chrome.store.set('settings', current)

    const settings = await getSettings()

    expect(settings.providers.map((p) => p.id)).toEqual(['p1'])
  })

  it('returns defaults without fabricating while the directory is unreachable', async () => {
    const { handle } = makeFakeRoot()
    stubIndexedDb(handle, 'prompt')

    const settings = await getSettings()

    expect(settings.providers).toEqual([])
    // Nothing was written over the gap.
    expect(chrome.store.has('settings')).toBe(false)
  })
})

describe('ensureSchema over an unreadable directory', () => {
  let chrome: ReturnType<typeof makeChromeMock>

  beforeEach(() => {
    chrome = makeChromeMock()
    vi.stubGlobal('chrome', chrome)
    resetStorageCache()
    // Force the bootstrap to run (it early-returns on a matching version).
    chrome.store.set('schemaVersion', 1)
  })

  afterEach(() => {
    resetStorageCache()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('fabricates nothing while a directory is configured but unreachable', async () => {
    const { handle } = makeFakeRoot()
    stubIndexedDb(handle, 'prompt')

    await ensureSchema()

    // Schema stamped, but no defaults written over the gap…
    expect(chrome.store.get('schemaVersion')).toBeGreaterThan(1)
    expect(chrome.store.has('settings')).toBe(false)
    expect(chrome.store.has('profiles')).toBe(false)
    expect(chrome.store.has('history')).toBe(false)
    // …and no seeded empty collections parked for the replay, where they
    // would clobber the real records on file.
    const outbox = (chrome.store.get('fs-outbox') ?? {}) as Record<string, unknown>
    expect(outbox.profiles).toBeUndefined()
    expect(outbox.history).toBeUndefined()
    expect(outbox.passwords).toBeUndefined()
    expect(outbox.conversations).toBeUndefined()
    // The skills seeding is benign: built-ins are folder files, and the
    // collection entry only ever flushes additional built-ins.
  })

  it('still seeds defaults in browser mode (no directory)', async () => {
    // No IndexedDB stub → no directory configured.
    await ensureSchema()

    expect(chrome.store.has('settings')).toBe(true)
    expect(chrome.store.get('profiles')).toEqual([])
    expect(chrome.store.get('history')).toEqual([])
  })
})
