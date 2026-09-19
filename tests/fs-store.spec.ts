import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  clearStorageDirectory,
  createFileArea,
  fileStorageArea,
  FsDirectory,
  getStorageMode,
  keyToPath,
  resetStorageCache,
  SKILLS_DIR,
  skillPath,
  syncEntriesToFiles,
  syncFilesToBrowser,
  syncSkillsToFiles,
  syncToFiles,
} from '../src/lib/fs-store'
import type { Skill } from '../src/lib/types'
import { notifyStoreChanged } from '../src/lib/store-events'

/**
 * The change bus itself is covered by `tests/store-events.spec.ts`; what matters
 * here is that the storage layer is wired to it, so it is mocked to a spy.
 */
vi.mock('../src/lib/store-events', () => ({
  notifyStoreChanged: vi.fn(),
  onStoreChanged: vi.fn(() => () => undefined),
}))

/**
 * In-memory `chrome.storage.local` double used to verify the mirror/fallback
 * path of the file-backed area.
 */
function makeChromeMock() {
  const store = new Map<string, unknown>()
  const local = {
    // `null` means "everything", the way `chrome.storage.local.get(null)` does.
    get: vi.fn(async (keys: string | string[] | null) => {
      const wanted = keys === null ? [...store.keys()] : typeof keys === 'string' ? [keys] : keys
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
  async *values(): AsyncIterableIterator<{ kind: 'file' | 'directory'; name: string }> {
    for (const [name, entry] of this.node.children) {
      yield { kind: entry.kind === 'dir' ? 'directory' : 'file', name }
    }
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

/**
 * Points the module's IndexedDB lookup at `handle` with the given permission
 * state, so the file-backed area resolves without a real File System Access
 * API. The resolved handle is cached module-wide, so callers must
 * `resetStorageCache()` before and after.
 */
function stubStoredHandle(handle: FakeDir, permission: PermissionState): void {
  const stored = {
    name: 'picked',
    queryPermission: async (): Promise<PermissionState> => permission,
    getDirectoryHandle: (name: string, opts: { create?: boolean }) =>
      handle.getDirectoryHandle(name, opts),
    getFileHandle: (name: string, opts: { create?: boolean }) => handle.getFileHandle(name, opts),
    removeEntry: (name: string) => handle.removeEntry(name),
    values: () => handle.values(),
  }
  stubIndexedDb(stored)
}

/** Same, but the handle exists while its permission sits at `'prompt'` — the
 *  post-restart state: a directory is configured yet unreachable from a
 *  context that cannot request permission (no user gesture). */
function stubPendingDirectory(handle: FakeDir): void {
  stubStoredHandle(handle, 'prompt')
}

function stubGrantedDirectory(handle: FakeDir): void {
  stubStoredHandle(handle, 'granted')
}

function stubIndexedDb(stored: unknown): void {
  const db = {
    transaction: () => ({
      objectStore: () => ({
        get: () => {
          const request: { result: unknown; onsuccess: null | (() => void) } = {
            result: stored,
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
      const request: {
        result: unknown
        onsuccess: null | (() => void)
        onupgradeneeded: null | (() => void)
      } = { result: db, onsuccess: null, onupgradeneeded: null }
      setTimeout(() => request.onsuccess?.(), 0)
      return request
    },
  })
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

  it('writes a value to a real file and leaves the browser store empty', async () => {
    const { handle, node } = makeFakeRoot()
    const area = createFileArea(handle as FileSystemDirectoryHandle)

    await area.set({ settings: { locale: 'zh' } })

    const fileEntry = dataDir(node).children.get('settings.json')
    expect(fileEntry).toBeDefined()
    expect(fileEntry?.kind).toBe('file')
    if (fileEntry && fileEntry.kind === 'file') {
      expect(JSON.parse(fileEntry.content)).toEqual({ locale: 'zh' })
    }
    // Deliberately NOT mirrored: a second copy in `chrome.storage.local` is what
    // filled its 10 MB quota, and the user asked for data to live in the
    // directory only.
    expect(chrome.store.has('settings')).toBe(false)
  })

  it('throws instead of silently doing nothing when the file cannot be created', async () => {
    // A revoked permission, a deleted directory, a full disk. The old code
    // resolved without writing and the mirror hid it; with no mirror that
    // silence would be silent data loss.
    const unreachable = {
      getDirectoryHandle: async () => ({
        getDirectoryHandle: async () => ({
          getFileHandle: async () => {
            throw new Error('permission denied')
          },
        }),
      }),
    }
    const area = createFileArea(unreachable as unknown as FileSystemDirectoryHandle)

    await expect(area.set({ settings: { locale: 'zh' } })).rejects.toThrow(/settings/)
    expect(chrome.store.has('settings')).toBe(false)
  })

  it('drops a staged copy once the value reaches a file', async () => {
    // Otherwise the next `syncToFiles` would push the older staged value back
    // over the newer file.
    const { handle, node } = makeFakeRoot()
    const area = createFileArea(handle as FileSystemDirectoryHandle)
    chrome.store.set('settings', { locale: 'stale' })

    await area.set({ settings: { locale: 'fresh' } })

    expect(chrome.store.has('settings')).toBe(false)
    const entry = dataDir(node).children.get('settings.json')
    expect(entry?.kind).toBe('file')
    if (entry?.kind === 'file') expect(JSON.parse(entry.content)).toEqual({ locale: 'fresh' })
  })

  it('announces every key it wrote, so listeners can re-read', async () => {
    const { handle } = makeFakeRoot()
    const area = createFileArea(handle as FileSystemDirectoryHandle)
    const notify = vi.mocked(notifyStoreChanged)
    notify.mockClear()

    await area.set({ settings: { locale: 'zh' }, workflows: [] })
    expect(notify.mock.calls.map((call) => call[0])).toEqual(['settings', 'workflows'])

    notify.mockClear()
    await area.remove('workflows')
    expect(notify.mock.calls.map((call) => call[0])).toEqual(['workflows'])
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

  it('removes the file and any staged copy of the key', async () => {
    const { handle, node } = makeFakeRoot()
    const area = createFileArea(handle as FileSystemDirectoryHandle)

    await area.set({ settings: { locale: 'en' } })
    expect(dataDir(node).children.has('settings.json')).toBe(true)

    // A value staged while the handle was unavailable must not outlive the
    // delete: the read fallback would resurrect it.
    chrome.store.set('settings', { locale: 'stale' })

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

  it('never writes the skills key as a JSON file (SKILL.md is used instead)', async () => {
    const { handle, node } = makeFakeRoot()
    const area = createFileArea(handle as FileSystemDirectoryHandle)

    await area.set({ skills: [{ id: 's1', name: 'Scrape' }] })

    const dir = dataDir(node)
    expect(dir.children.has('skills.json')).toBe(false)
    expect(dir.children.has('skills')).toBe(false)
    // Nor may it be parked in the browser store: skills are SKILL.md files.
    expect(chrome.store.has('skills')).toBe(false)
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

  it('clears each migrated key from the browser store', async () => {
    // The point of the migration: the data ends up in the user's directory and
    // NOT in `chrome.storage.local`, which is what kept filling its quota.
    const { handle, node } = makeFakeRoot()
    const mirror = { settings: { locale: 'zh' }, workflows: [{ id: 'w1', name: 'Daily' }] }
    for (const [key, value] of Object.entries(mirror)) chrome.store.set(key, value)

    await syncEntriesToFiles(mirror, handle as FileSystemDirectoryHandle)

    expect(chrome.store.has('settings')).toBe(false)
    expect(chrome.store.has('workflows')).toBe(false)
    // …and nothing was lost on the way: both landed as files.
    const dir = dataDir(node)
    expect(JSON.parse((dir.children.get('settings.json') as FileNode).content)).toEqual(
      mirror.settings,
    )
    expect(JSON.parse((dir.children.get('workflows.json') as FileNode).content)).toEqual(
      mirror.workflows,
    )
  })

  it('never persists the skills key as a JSON file (SKILL.md is used instead)', async () => {
    const { handle, node } = makeFakeRoot()
    const mirror = { skills: [{ id: 's1', name: 'Scrape' }] }

    await syncEntriesToFiles(mirror, handle as FileSystemDirectoryHandle)

    const dir = dataDir(node)
    expect(dir.children.has('skills.json')).toBe(false)
    expect(dir.children.has('skills')).toBe(false)
  })
})

describe('syncSkillsToFiles', () => {
  it('writes each skill to skills/<slug>/SKILL.md in the general-skill layout', async () => {
    const { handle, node } = makeFakeRoot()
    const skills: Skill[] = [
      {
        id: 's1',
        name: 'Web Scraper',
        description: 'scrape pages',
        instructions: '# Instructions\nFetch the page.',
        autoMatch: true,
        createdAt: 1_720_000_000_000,
        updatedAt: 1_720_000_000_001,
      },
      {
        id: 's2',
        name: '翻译助手',
        description: 'translate',
        instructions: '把中文翻译成英文',
        autoMatch: false,
        createdAt: 1_720_000_000_000,
        updatedAt: 1_720_000_000_000,
      },
    ]

    await syncSkillsToFiles(skills, handle as FileSystemDirectoryHandle)

    const dir = dataDir(node)
    const skillsDir = dir.children.get('skills') as Extract<Node, { kind: 'dir' }>
    expect(skillsDir).toBeDefined()
    // ASCII name keeps its readable folder; non-ASCII collapses to a slug.
    const scraperDir = skillsDir.children.get('Web_Scraper') as Extract<Node, { kind: 'dir' }>
    const transDir = skillsDir.children.get('____') as Extract<Node, { kind: 'dir' }>
    expect(scraperDir).toBeDefined()
    expect(transDir).toBeDefined()

    const md = (scraperDir.children.get('SKILL.md') as FileNode).content
    expect(md).toContain('name: Web Scraper')
    expect(md).toContain('description: scrape pages')
    expect(md).toContain('autoMatch: true')
    expect(md).toContain('# Instructions\nFetch the page.')
  })
})

describe('FsDirectory skill layout', () => {
  it('lists existing skill folder slugs', async () => {
    const { handle } = makeFakeRoot()
    const fs = new FsDirectory(handle as FileSystemDirectoryHandle)
    await fs.writeText(skillPath('web_scraper'), 'a')
    await fs.writeText(skillPath('translator'), 'b')

    expect(await fs.listSubdirectories(SKILLS_DIR)).toEqual(['translator', 'web_scraper'])
  })

  it('returns null when the skills directory does not exist yet', async () => {
    const { handle } = makeFakeRoot()
    const fs = new FsDirectory(handle as FileSystemDirectoryHandle)
    expect(await fs.listSubdirectories(SKILLS_DIR)).toBeNull()
  })

  it('removes a skill folder recursively', async () => {
    const { handle, node } = makeFakeRoot()
    const fs = new FsDirectory(handle as FileSystemDirectoryHandle)
    await fs.writeText(skillPath('web_scraper'), 'a')

    await fs.removeDirectory([SKILLS_DIR, 'web_scraper'])

    const dir = dataDir(node)
    const skillsDir = dir.children.get('skills') as Extract<Node, { kind: 'dir' }>
    expect(skillsDir.children.has('web_scraper')).toBe(false)
    // The skills directory itself stays (other skills may remain).
    expect(dir.children.has('skills')).toBe(true)
  })

  it('round-trips a skill file through the same read path storage uses', async () => {
    const { handle } = makeFakeRoot()
    const fs = new FsDirectory(handle as FileSystemDirectoryHandle)
    await fs.writeText(skillPath('x'), '# not SKILL.md yet') // placeholder overwrite check
    await fs.writeText(skillPath('x'), '---\nname: X\ndescription: d\n---\nbody\n')

    const text = await fs.readText(skillPath('x'))
    expect(text).toContain('name: X')
    expect(text).toContain('body')
  })
})

describe('getStorageMode', () => {
  it('reports browser mode when no directory handle exists', async () => {
    // No indexedDB in the node test environment, so the handle cannot resolve.
    expect(await getStorageMode()).toBe('browser')
  })
})

describe('chrome.storage.local quota', () => {
  /**
   * The exact rejection Chrome produces past QUOTA_BYTES. A user hits it as a
   * failed "save as workflow" with this string shown verbatim in the chat, so
   * the assertion below pins the translation rather than the wording.
   */
  const CHROME_QUOTA_ERROR = 'Resource::kQuotaBytes quota exceeded'

  /** Stubs a `chrome.storage.local` whose writes are always rejected. */
  function stubFullStorage(reason = CHROME_QUOTA_ERROR): void {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {
            throw new Error(reason)
          }),
          remove: vi.fn(async () => undefined),
        },
      },
    })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('replaces the raw Chrome rejection with an actionable message', async () => {
    // No indexedDB here, so the area resolves to the browser mirror — the mode
    // a user is in before picking a storage directory, and the one where a full
    // quota reaches them as a failed save.
    stubFullStorage()

    const failure = await fileStorageArea()
      .set({ workflows: [] })
      .then(
        () => null,
        (error: unknown) => error as Error,
      )

    expect(failure).toBeInstanceOf(Error)
    const text = failure?.message ?? ''
    // Actionable: names the settings path that removes the ceiling.
    expect(text).toContain('数据存储')
    // Diagnostic: keeps Chrome's original wording, so a bug report is greppable.
    expect(text).toContain(CHROME_QUOTA_ERROR)
    // And it is no longer ONLY that wording — which is what the user reported.
    expect(text).not.toBe(CHROME_QUOTA_ERROR)
  })

  it('passes a non-quota write failure through untouched', async () => {
    // Translating an unrelated failure would hide the real cause.
    stubFullStorage('Extension context invalidated.')

    await expect(fileStorageArea().set({ settings: {} })).rejects.toThrow(
      'Extension context invalidated.',
    )
  })

  it('keeps a file-backed save succeeding when only the mirror is full', async () => {
    // The file write is the durable one; a full mirror must not turn a save
    // that landed on disk into a reported failure.
    const { handle, node } = makeFakeRoot()
    stubFullStorage()

    await expect(
      createFileArea(handle as FileSystemDirectoryHandle).set({ settings: { locale: 'zh' } }),
    ).resolves.toBeUndefined()

    const entry = dataDir(node).children.get('settings.json')
    expect(entry?.kind).toBe('file')
  })

  it('declares unlimitedStorage in the manifest', () => {
    // Dropping this permission silently reinstates the 10 MB cap and, with it,
    // a save that fails for a reason the user cannot act on.
    const source = readFileSync(
      fileURLToPath(new URL('../manifest.config.ts', import.meta.url)),
      'utf8',
    )
    const permissions = /permissions:\s*\[([\s\S]*?)\]/.exec(source)?.[1] ?? ''
    // Comments are stripped so only a real entry satisfies the assertion.
    const entries = permissions.replace(/\/\/.*$/gm, '')
    expect(entries).toContain("'unlimitedStorage'")
  })
})

describe('switching back to browser storage', () => {
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

  it('round-trips: out to files, then back into the browser store', async () => {
    // The guarantee that makes the switch non-destructive. Without the reverse
    // copy the panel would come up empty after switching back, which reads as
    // "everything was deleted".
    const { handle, node } = makeFakeRoot()
    stubGrantedDirectory(handle as FakeDir)
    const original: Record<string, unknown> = {
      settings: { locale: 'zh' },
      workflows: [{ id: 'w1', name: 'Daily' }],
      'conv:abc': { messages: [{ role: 'user', content: 'hi' }] },
    }
    for (const [key, value] of Object.entries(original)) chrome.store.set(key, value)

    await syncToFiles()
    // Content migrated: on disk, and gone from the browser store. Config keys
    // (`settings`) deliberately STAY in browser storage — the directory holds
    // user content, not the extension's own configuration.
    expect(dataDir(node).children.has('workflows.json')).toBe(true)
    expect(chrome.store.has('settings')).toBe(true)
    expect(dataDir(node).children.has('settings.json')).toBe(false)
    expect(chrome.store.has('workflows')).toBe(false)
    expect(chrome.store.has('conv:abc')).toBe(false)

    await syncFilesToBrowser()

    expect(chrome.store.get('settings')).toEqual(original.settings)
    expect(chrome.store.get('workflows')).toEqual(original.workflows)
    expect(chrome.store.get('conv:abc')).toEqual(original['conv:abc'])
  })

  it('rebuilds the skills collection from the SKILL.md folders', async () => {
    // Skills are never a `<key>.json`, so the generic walk cannot find them —
    // they have to be re-read from their folders.
    const { handle } = makeFakeRoot()
    stubGrantedDirectory(handle as FakeDir)
    chrome.store.set('skills', [
      {
        id: 's1',
        name: 'Scraper',
        description: 'scrape pages',
        instructions: 'Fetch the page.',
        autoMatch: true,
        createdAt: 1_720_000_000_000,
        updatedAt: 1_720_000_000_001,
      },
    ])

    await syncToFiles()
    expect(chrome.store.has('skills')).toBe(false)

    await syncFilesToBrowser()

    const skills = chrome.store.get('skills') as Array<{ id: string; name: string }>
    expect(skills.map((skill) => skill.id)).toEqual(['s1'])
    expect(skills[0]?.name).toBe('Scraper')
  })

  it('writes nothing when the folder holds nothing', async () => {
    const { handle } = makeFakeRoot()
    stubGrantedDirectory(handle as FakeDir)

    expect(await syncFilesToBrowser()).toBe(0)
    expect(chrome.store.size).toBe(0)
  })
})

describe('content/config key routing', () => {
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

  it('keeps config keys in browser storage even when a directory is granted', async () => {
    const { handle, node } = makeFakeRoot()
    stubGrantedDirectory(handle as FakeDir)
    const area = fileStorageArea()

    await area.set({ settings: { locale: 'zh' } })

    expect(chrome.store.get('settings')).toEqual({ locale: 'zh' })
    expect(dataDir(node).children.has('settings.json')).toBe(false)

    // Content keys behave the opposite way: file only, never mirrored.
    await area.set({ workflows: [{ id: 'w1', name: 'Daily' }] })
    expect(dataDir(node).children.has('workflows.json')).toBe(true)
    expect(chrome.store.has('workflows')).toBe(false)
  })

  it('adopts a legacy config file into browser storage on first read', async () => {
    const { handle } = makeFakeRoot()
    stubGrantedDirectory(handle as FakeDir)
    // An older version migrated config into the directory; the new design
    // reads config from browser storage, so the file is adopted once.
    const fs = new FsDirectory(handle as FileSystemDirectoryHandle)
    await fs.writeText(['settings.json'], JSON.stringify({ locale: 'zh' }))

    const area = fileStorageArea()
    const got = await area.get('settings')

    expect(got.settings).toEqual({ locale: 'zh' })
    expect(chrome.store.get('settings')).toEqual({ locale: 'zh' })
  })

  it('parks content writes in the outbox while the directory is unreachable', async () => {
    const { handle } = makeFakeRoot()
    stubPendingDirectory(handle as FakeDir)
    const area = fileStorageArea()

    const value = [{ id: 'w1', name: 'Daily' }]
    await area.set({ workflows: value })

    // Not misdirected into browser storage as a content key…
    expect(chrome.store.has('workflows')).toBe(false)
    // …but durably parked in the outbox…
    const outbox = chrome.store.get('fs-outbox') as Record<string, { value: unknown; at: number }>
    expect(outbox.workflows?.value).toEqual(value)
    // …and no partial file was written.
    const fs = new FsDirectory(handle as FileSystemDirectoryHandle)
    expect(await fs.readText(['workflows.json'])).toBeNull()
  })

  it('overlays a parked outbox entry (and tombstone) on reads', async () => {
    const { handle } = makeFakeRoot()
    stubPendingDirectory(handle as FakeDir)
    const area = fileStorageArea()

    await area.set({ workflows: [{ id: 'w1', name: 'Daily' }] })
    await area.set({ profiles: [{ id: 'p1' }] })
    await area.remove('profiles')

    expect(await area.get('workflows')).toEqual({ workflows: [{ id: 'w1', name: 'Daily' }] })
    // The tombstone makes the key read as absent — it must not fall through to
    // any other layer.
    expect(await area.get('profiles')).toEqual({})
  })

  it('drains the outbox into the directory once access is back', async () => {
    const { handle, node } = makeFakeRoot()
    stubPendingDirectory(handle as FakeDir)
    const area = fileStorageArea()
    const value = [{ id: 'w1', name: 'Daily' }]
    await area.set({ workflows: value })

    stubGrantedDirectory(handle as FakeDir)
    await syncToFiles()

    expect(JSON.parse((dataDir(node).children.get('workflows.json') as FileNode).content)).toEqual(
      value,
    )
    const outbox = (chrome.store.get('fs-outbox') ?? {}) as Record<string, unknown>
    expect(outbox.workflows).toBeUndefined()
    // Reads now come from the file.
    expect(await area.get('workflows')).toEqual({ workflows: value })
  })

  it('carries a deletion made while unreachable into the directory', async () => {
    const { handle, node } = makeFakeRoot()
    stubGrantedDirectory(handle as FakeDir)
    const area = fileStorageArea()
    await area.set({ workflows: [{ id: 'w1', name: 'Daily' }] })

    // Permission drops; the user deletes the workflow anyway.
    stubPendingDirectory(handle as FakeDir)
    await area.remove('workflows')

    stubGrantedDirectory(handle as FakeDir)
    await syncToFiles()

    expect(dataDir(node).children.has('workflows.json')).toBe(false)
    expect(await area.get('workflows')).toEqual({})
  })

  it('reads the cached value while the directory is unreachable', async () => {
    const { handle } = makeFakeRoot()
    stubGrantedDirectory(handle as FakeDir)
    const area = fileStorageArea()
    const value = [{ id: 'w1', name: 'Daily' }]
    await area.set({ workflows: value })

    // Post-restart, permission back at 'prompt': the files cannot be read, but
    // the panel must not render an empty list (reads as data loss).
    stubPendingDirectory(handle as FakeDir)
    expect(await area.get('workflows')).toEqual({ workflows: value })
  })

  it('drops an outbox entry that is older than the file (staleness guard)', async () => {
    const { handle, node } = makeFakeRoot()
    stubGrantedDirectory(handle as FakeDir)
    const area = fileStorageArea()

    const newer = [{ id: 'w1', name: 'Saved after reconnect' }]
    await area.set({ workflows: newer })

    // Craft an outbox entry predating the file write (a write parked, then a
    // newer direct write landed before the replay ran).
    const older = [{ id: 'w1', name: 'Parked during the outage' }]
    chrome.store.set('fs-outbox', { workflows: { value: older, at: Date.now() - 60_000 } })

    await syncToFiles()

    expect(JSON.parse((dataDir(node).children.get('workflows.json') as FileNode).content)).toEqual(
      newer,
    )
    const outbox = (chrome.store.get('fs-outbox') ?? {}) as Record<string, unknown>
    expect(outbox.workflows).toBeUndefined()
  })

  it('merges a legacy browser copy with the file instead of overwriting it', async () => {
    const { handle, node } = makeFakeRoot()
    stubGrantedDirectory(handle as FakeDir)
    // File holds the newer w1; the legacy browser mirror holds a stale w1 AND
    // a workflow the file never saw. The old whole-blob overwrite lost w2.
    const fs = new FsDirectory(handle as FileSystemDirectoryHandle)
    await fs.writeText(['workflows.json'], JSON.stringify([{ id: 'w1', updatedAt: 200 }]))
    chrome.store.set('workflows', [
      { id: 'w1', updatedAt: 100 },
      { id: 'w2', updatedAt: 300 },
    ])

    await syncToFiles()

    expect(JSON.parse((dataDir(node).children.get('workflows.json') as FileNode).content)).toEqual([
      { id: 'w1', updatedAt: 200 },
      { id: 'w2', updatedAt: 300 },
    ])
    // Migrated keys leave the browser store.
    expect(chrome.store.has('workflows')).toBe(false)
  })

  it('folds the outbox into browser storage when switching back', async () => {
    const { handle } = makeFakeRoot()
    stubGrantedDirectory(handle as FakeDir)
    const area = fileStorageArea()
    await area.set({ workflows: [{ id: 'w1', name: 'On file' }] })

    // One more write parks in the outbox (newer than the file)…
    stubPendingDirectory(handle as FakeDir)
    await area.set({ workflows: [{ id: 'w1', name: 'Parked later' }] })

    // …and the switch to browser storage must land the NEWEST state, then
    // clear the fallback structures.
    stubGrantedDirectory(handle as FakeDir)
    await clearStorageDirectory()

    expect(chrome.store.get('workflows')).toEqual([{ id: 'w1', name: 'Parked later' }])
    expect(chrome.store.has('fs-outbox')).toBe(false)
    expect([...chrome.store.keys()].some((key) => key.startsWith('fs-cache:'))).toBe(false)
  })
})
