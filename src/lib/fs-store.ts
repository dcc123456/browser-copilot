/**
 * File-backed storage.
 *
 * The durable copy of every piece of USER CONTENT — conversations, workflows,
 * drafts, history, profiles, passwords, tasks, checkpoints, skills, agents —
 * lives in plain JSON files on the user's hard drive instead of inside
 * `chrome.storage.local`. The user picks a directory once via the File System
 * Access API (`showDirectoryPicker`); the directory handle is persisted in
 * IndexedDB, and a `browser-copilot` subfolder inside it holds one JSON file
 * per logical key (conversation transcripts under `conversations/<id>.json`).
 *
 * Two key classes, routed per write (see {@link isConfigKey}):
 * - **Content keys** go to the directory. The directory is the only durable
 *   home: nothing is mirrored back into `chrome.storage.local`. When the
 *   handle is unavailable (right after a restart its permission may sit at
 *   `'prompt'`, and re-granting needs a user gesture a background worker
 *   cannot provide) writes park in a durable outbox and reads fall back to a
 *   read cache — see `lib/fs-outbox.ts`. Neither structure is a second copy:
 *   the outbox drains into files and empties, the cache is a read-side
 *   convenience that is cleared when file mode ends.
 * - **Config keys** (`settings`, `schemaVersion`, `feishuConfig`, panel
 *   positions) are extension configuration, not user content: they live in
 *   `chrome.storage.local` permanently, in every mode, and are never written
 *   to the directory. (Older versions did migrate them into files; the read
 *   path adopts such legacy files back into browser storage once.)
 *
 * The picker and permission requests require a window plus a user gesture, so
 * those entry points (`pickStorageDirectory`, `ensureFileAccess`, `syncToFiles`)
 * run in the side panel. The service worker only consumes the handle: reads and
 * writes succeed as long as the permission is already granted for this
 * extension's origin (which it is once the user has chosen the directory).
 *
 * Content writes happen ONLY in the service worker (panel UIs go through
 * commands), which makes per-key write queues in the persistence modules a
 * complete serialization of read-modify-write cycles — see `lib/key-lock.ts`.
 *
 * `chrome.storage.onChanged` is not how the UI learns about a write (the
 * content keys no longer live there); `lib/store-events` carries the
 * notification instead.
 *
 * @module lib/fs-store
 */
import { skillFromMarkdown, skillSlug, skillToMarkdown } from './skills-import'
import { agentFromMarkdown, agentSlug, agentToMarkdown } from './agents-import'
import { notifyStoreChanged } from './store-events'
import {
  CACHE_INDEX_KEY,
  CACHE_PREFIX,
  OUTBOX_KEY,
  chromeLocalArea,
  clearFallbacks,
  dropOutboxEntry,
  enqueueOutbox,
  hasChromeStorage,
  readCache,
  readOutboxMap,
  removeCache,
  replayOutbox,
  writeCache,
} from './fs-outbox'
import type { Agent, Skill } from './types'

/**
 * Subfolder inside the picked directory that holds the JSON data files.
 * A fixed name keeps the extension's data from mixing with the user's own
 * files when they point us at a folder they already use.
 */
export const DATA_DIR = 'browser-copilot'

/** The keyspace prefix for a conversation transcript (see `lib/storage.ts`). */
const CONVERSATION_PREFIX = 'conv:'

/**
 * The keyspace prefix for a run's step checkpoints (M4). Persisted as
 * `checkpoints/<runId>.json` — the same convention the server runner uses — so
 * a run's resume points are readable with a plain file browser.
 */
export const CHECKPOINT_PREFIX = 'cp:'

const IDB_DB = 'browser-copilot-fs'
const IDB_STORE = 'directory'
const IDB_KEY = 'root'

/** Whether a directory is configured and usable, or storage is in the browser. */
export type StorageMode = 'file' | 'browser'

/**
 * The storage surface the persistence modules use. Shape-matches the slice of
 * `chrome.storage.local` they depend on, so swapping the backing is a local
 * change.
 */
export interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
}

// --- Key classification --------------------------------------------------------

/**
 * Extension configuration keys. These stay in `chrome.storage.local` in EVERY
 * mode — the directory holds user content, not the extension's own settings.
 * Everything else routed through the area is user content and lives in the
 * configured directory.
 */
export const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'settings',
  'schemaVersion',
  'feishuConfig',
  // Written directly by `background/panel-minimize.ts` (never via the area);
  // listed so a legacy copy is never migrated into the directory.
  'floatingButtonPositions',
])

/** Whether `key` is extension configuration rather than user content. */
export function isConfigKey(key: string): boolean {
  return CONFIG_KEYS.has(key)
}

/** Whether a `chrome.storage.local` key belongs to one of the fallback structures. */
function isFallbackKey(key: string): boolean {
  return key === OUTBOX_KEY || key === CACHE_INDEX_KEY || key.startsWith(CACHE_PREFIX)
}

// --- Key → file mapping ------------------------------------------------------

/** Replaces characters that are unsafe in a file name. Keys are code-controlled,
 *  so this is defensive, not a trust boundary. */
function sanitizeFileSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, '_') || 'key'
}

/**
 * Maps a logical storage key to the file path segments under the data folder.
 *
 * `conv:<id>` transcripts go to `conversations/<id>.json` and `cp:<runId>`
 * run checkpoints go to `checkpoints/<runId>.json` so neither sits in the root
 * next to settings; every other key becomes `<key>.json`.
 * Exported for direct testing.
 */
export function keyToPath(key: string): string[] {
  if (key.startsWith(CONVERSATION_PREFIX)) {
    return ['conversations', `${sanitizeFileSegment(key.slice(CONVERSATION_PREFIX.length))}.json`]
  }
  if (key.startsWith(CHECKPOINT_PREFIX)) {
    return ['checkpoints', `${sanitizeFileSegment(key.slice(CHECKPOINT_PREFIX.length))}.json`]
  }
  return [`${sanitizeFileSegment(key)}.json`]
}

/**
 * Skills are stored as files in the general-skill layout — one folder per skill
 * containing a `SKILL.md` (YAML frontmatter + Markdown body) — under the data
 * directory. `skillPath` maps a folder slug to those segments.
 */
export const SKILLS_DIR = 'skills'
const SKILL_FILE = 'SKILL.md'

export function skillPath(slug: string): string[] {
  return [SKILLS_DIR, sanitizeFileSegment(slug), SKILL_FILE]
}

/**
 * Agents mirror the skill file layout — one folder per agent containing an
 * `AGENT.md` (YAML frontmatter + Markdown body) under the data directory.
 */
export const AGENTS_DIR = 'agents'
const AGENT_FILE = 'AGENT.md'

export function agentPath(slug: string): string[] {
  return [AGENTS_DIR, sanitizeFileSegment(slug), AGENT_FILE]
}

// --- IndexedDB: directory-handle persistence ---------------------------------

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'))
      return
    }
    const request = indexedDB.open(IDB_DB, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IDB_STORE)) {
        request.result.createObjectStore(IDB_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
  })
}

async function idbGet(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openIdb()
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly')
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY)
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

async function idbPut(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openIdb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(handle, IDB_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
  })
}

async function idbDelete(): Promise<void> {
  try {
    const db = await openIdb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).delete(IDB_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    // Nothing stored — nothing to clear.
  }
}

// --- File I/O ----------------------------------------------------------------

/**
 * Thin wrapper over a directory handle that reads/writes JSON files under the
 * data subfolder. Kept testable by accepting the handle in the constructor.
 */
export class FsDirectory {
  private dataDirPromise: Promise<FileSystemDirectoryHandle> | null = null

  constructor(private readonly root: FileSystemDirectoryHandle) {}

  /** The `browser-copilot` subfolder holding the data files (created lazily). */
  private dataDir(): Promise<FileSystemDirectoryHandle> {
    if (!this.dataDirPromise) {
      // If creating the subfolder fails for any reason, fall back to the picked
      // directory itself so storage keeps working.
      this.dataDirPromise = this.root
        .getDirectoryHandle(DATA_DIR, { create: true })
        .catch(() => this.root)
    }
    return this.dataDirPromise
  }

  private async fileHandle(
    segments: string[],
    create: boolean,
  ): Promise<FileSystemFileHandle | null> {
    const dir = await this.dataDir()
    let handle: FileSystemDirectoryHandle = dir
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i]
      if (!segment) return null
      try {
        handle = await handle.getDirectoryHandle(segment, { create })
      } catch {
        // A missing intermediate directory means the file is absent (read) or
        // cannot exist (a create failure surfaces below / in writeText).
        return null
      }
    }
    const name = segments[segments.length - 1]
    if (!name) return null
    try {
      return await handle.getFileHandle(name, { create })
    } catch {
      return null
    }
  }

  /** Reads a file's text, or `null` when it does not exist / cannot be read. */
  async readText(segments: string[]): Promise<string | null> {
    const fileHandle = await this.fileHandle(segments, false)
    if (!fileHandle) return null
    try {
      const file = await fileHandle.getFile()
      return await file.text()
    } catch {
      return null
    }
  }

  /**
   * Creates or overwrites a file with the given text. `createWritable` writes
   * to a swap file and commits on `close()`, so a crash mid-write leaves the
   * previous content intact — no extra `.bak` step is needed.
   */
  async writeText(segments: string[], text: string): Promise<void> {
    const fileHandle = await this.fileHandle(segments, true)
    // `create: true` was requested, so a missing handle means the directory
    // could not be reached — not that the file was absent. Throwing is what
    // stops a failed write from being indistinguishable from a successful one.
    if (!fileHandle) throw new Error(`无法在存储目录中创建 ${segments.join('/')}`)
    const writable = await fileHandle.createWritable()
    try {
      await writable.write(text)
    } finally {
      await writable.close()
    }
  }

  /** Deletes a file, ignoring "already gone" errors. */
  async remove(segments: string[]): Promise<void> {
    const dir = await this.dataDir()
    let handle: FileSystemDirectoryHandle = dir
    try {
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i]
        if (!segment) return
        handle = await handle.getDirectoryHandle(segment, { create: false })
      }
      const name = segments[segments.length - 1]
      if (!name) return
      await handle.removeEntry(name)
    } catch {
      // Entry already gone — nothing to do.
    }
  }

  /**
   * Lists the subdirectory names under `segment` inside the data folder, or
   * `null` when that directory does not exist. `[]` (an existing but empty
   * directory) is distinct from `null`, so callers can tell "nothing stored
   * yet" from "nothing on disk".
   */
  async listSubdirectories(segment: string): Promise<string[] | null> {
    const dir = await this.dataDir()
    try {
      const sub = await dir.getDirectoryHandle(segment, { create: false })
      const names: string[] = []
      for await (const entry of sub.values()) {
        if (entry.kind === 'directory') names.push(entry.name)
      }
      return names.sort()
    } catch {
      return null
    }
  }

  /**
   * Lists the file names directly inside `segments` under the data folder (`[]`
   * is the data folder root). Returns `[]` when that directory does not exist,
   * which is the right answer for "nothing stored there" — the only caller walks
   * the folder to rebuild the browser store, where an absent directory and an
   * empty one are equivalent.
   */
  async listFiles(segments: string[] = []): Promise<string[]> {
    try {
      let handle = await this.dataDir()
      for (const segment of segments) {
        handle = await handle.getDirectoryHandle(segment, { create: false })
      }
      const names: string[] = []
      for await (const entry of handle.values()) {
        if (entry.kind === 'file') names.push(entry.name)
      }
      return names.sort()
    } catch {
      return []
    }
  }

  /** Recursively deletes a directory entry under the data folder. */
  async removeDirectory(segments: string[]): Promise<void> {
    const dir = await this.dataDir()
    let handle: FileSystemDirectoryHandle = dir
    try {
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i]
        if (!segment) return
        handle = await handle.getDirectoryHandle(segment, { create: false })
      }
      const name = segments[segments.length - 1]
      if (!name) return
      await handle.removeEntry(name, { recursive: true })
    } catch {
      // Entry already gone — nothing to do.
    }
  }
}

// --- File-backed area --------------------------------------------------------

/**
 * A `StorageArea` backed by real files. Writes go to files only and announce
 * themselves through `lib/store-events`.
 *
 * Reads are layered: the file first, then a pending outbox entry (a write made
 * while the handle was unavailable — it REPLACES the file value, and a
 * tombstone entry makes the key read as absent), then the read cache, then any
 * legacy pre-outbox mirror value. The layers only ever answer for keys the
 * more durable layer does not know (a tombstone never falls through), so a
 * read-modify-write always starts from the full latest state.
 */
export function createFileArea(handle: FileSystemDirectoryHandle): StorageArea {
  const fs = new FsDirectory(handle)
  return {
    async get(keys) {
      const wanted = typeof keys === 'string' ? [keys] : keys
      const out: Record<string, unknown> = {}
      const missing: string[] = []
      for (const key of wanted) {
        const text = await fs.readText(keyToPath(key))
        if (text === null) {
          missing.push(key)
          continue
        }
        try {
          out[key] = JSON.parse(text) as unknown
        } catch {
          // Corrupt file — fall through to the pending/cache layers rather
          // than surfacing an unparsable value to a caller that trusts the
          // shape.
          missing.push(key)
        }
      }
      // Pending outbox entries overlay the file state: a value replaces it, a
      // tombstone makes the key read as absent and never falls through.
      const pending = await readOutboxMap()
      for (const key of wanted) {
        const entry = pending[key]
        if (!entry) continue
        if (entry.value === null) delete out[key]
        else out[key] = entry.value
      }
      const tombstoned = new Set(
        wanted.filter((key) => pending[key]?.value === null),
      )
      const unresolved = wanted.filter(
        (key) => !(key in out) && !tombstoned.has(key),
      )
      if (unresolved.length === 0) return out
      // Read cache: the last value that reached a file, served when the file
      // cannot be read (handle down, or the file was removed externally).
      const stillMissing: string[] = []
      for (const key of unresolved) {
        const cached = await readCache(key)
        if (cached === undefined) stillMissing.push(key)
        else out[key] = cached
      }
      if (stillMissing.length > 0) {
        // Legacy mirror values (pre-outbox versions kept staged writes here).
        Object.assign(out, await chromeLocalArea.get(stillMissing))
      }
      return out
    },
    async set(items) {
      const written: string[] = []
      for (const [key, value] of Object.entries(items)) {
        // Skills/agents live as folder-per-entity markdown files, not as a JSON
        // blob in the data folder; `storage.ts` writes those files directly.
        // Skipping BOTH keys here is essential — otherwise the collection
        // double-writes as both `skills.json` and `skills/<slug>/SKILL.md`
        // (likewise for agents), surfacing duplicate entries after upgrade.
        if (key === SKILLS_DIR || key === AGENTS_DIR) continue
        try {
          await fs.writeText(keyToPath(key), JSON.stringify(value))
        } catch (error) {
          // A failed disk write must be visible. The value is ALSO parked in
          // the outbox so the write survives even if the caller ignores the
          // error; the replay's staleness guard drops it once a newer direct
          // write has landed.
          await enqueueOutbox(key, value).catch(() => undefined)
          throw new Error(
            `写入存储目录失败（${key}）：${error instanceof Error ? error.message : String(error)}。` +
              '请确认该目录仍然存在、且扩展仍有读写权限——在「设置 → 数据存储」里可以重新连接。',
          )
        }
        written.push(key)
      }
      if (written.length === 0) return
      for (const key of written) {
        const value = items[key]
        // Drop any legacy staged copy of a key that just landed on disk, and
        // refresh the read cache (also the replay's version stamp).
        await chromeLocalArea.remove(key).catch(() => undefined)
        await dropOutboxEntry(key).catch(() => undefined)
        await writeCache(key, value)
        notifyStoreChanged(key)
      }
    },
    async remove(keys) {
      const wanted = typeof keys === 'string' ? [keys] : keys
      for (const key of wanted) await fs.remove(keyToPath(key))
      // Clear the fallback layers BEFORE notifying: a listener that re-reads
      // must not find the deleted value still sitting in a fallback.
      for (const key of wanted) {
        await dropOutboxEntry(key).catch(() => undefined)
        await removeCache(key).catch(() => undefined)
        await chromeLocalArea.remove(key).catch(() => undefined)
      }
      for (const key of wanted) notifyStoreChanged(key)
    },
  }
}

// --- Handle resolution -------------------------------------------------------

let cachedHandle: FileSystemDirectoryHandle | null = null
let resolving: Promise<FileSystemDirectoryHandle | null> | null = null

/** Drops the in-memory handle cache after the user (re)configures storage. */
export function resetStorageCache(): void {
  cachedHandle = null
  resolving = null
}

/**
 * Resolves the configured directory handle when its read-write permission is
 * granted, else `null`.
 *
 * `request` also attempts `requestPermission` when the permission is merely
 * pending. That call needs a user gesture and a window, so only the side panel
 * should pass `true`; a service worker would get `'prompt'` back and return
 * `null` (falling back to the outbox/cache) instead of hanging.
 */
async function resolveHandle(request = false): Promise<FileSystemDirectoryHandle | null> {
  if (cachedHandle) {
    try {
      if ((await cachedHandle.queryPermission({ mode: 'readwrite' })) === 'granted') {
        return cachedHandle
      }
    } catch {
      // Permission API unavailable — fall through and re-read from IndexedDB.
    }
    cachedHandle = null
  }
  if (!resolving) {
    resolving = (async () => {
      try {
        const handle = await idbGet()
        if (!handle) return null
        let state: PermissionState
        try {
          state = await handle.queryPermission({ mode: 'readwrite' })
          if (state === 'prompt' && request && typeof handle.requestPermission === 'function') {
            state = await handle.requestPermission({ mode: 'readwrite' })
          }
        } catch {
          return null
        }
        if (state !== 'granted') return null
        cachedHandle = handle
        return handle
      } catch {
        return null
      }
    })().finally(() => {
      // Do not cache negatives: a directory configured later (or a permission
      // granted later) must be noticed on the next call.
      resolving = null
    })
  }
  return resolving
}

/** Whether a directory is configured at all (even if its permission is down). */
async function isDirectoryConfigured(): Promise<boolean> {
  return (await idbGet()) !== null
}

/** Exported for the schema bootstrap: see `ensureSchema` in `lib/storage.ts`. */
export function isStorageDirectoryConfigured(): Promise<boolean> {
  return isDirectoryConfigured()
}

/**
 * Reads a config key's legacy file — left in the directory by versions that
 * migrated config into it — and adopts the value into browser storage.
 *
 * Returns the file's value, or `undefined` when no directory is usable, the
 * file is absent, or it is unparsable (in which case browser storage is left
 * untouched). Only config keys are adoptable; content keys live in the file
 * area and have their own read layers.
 */
export async function adoptLegacyConfigValue(key: string): Promise<unknown> {
  if (!isConfigKey(key)) return undefined
  const handle = await resolveHandle(false)
  if (!handle) return undefined
  const text = await new FsDirectory(handle).readText(keyToPath(key))
  if (text === null) return undefined
  try {
    const value = JSON.parse(text) as unknown
    await chromeLocalArea.set({ [key]: value }).catch(() => undefined)
    return value
  } catch {
    return undefined
  }
}

// --- Public entry points -----------------------------------------------------

/**
 * The storage area used by the persistence modules. Routes per key:
 * config keys always go to `chrome.storage.local`; content keys go to the
 * configured directory, park in the outbox while it is unreachable, and live
 * directly in `chrome.storage.local` when no directory is configured at all
 * (browser mode). A single instance is fine because the backing choice is made
 * per call.
 *
 * Notifications are emitted here on the non-file paths: `createFileArea`
 * announces its own writes.
 */
let sharedArea: StorageArea | null = null

export function fileStorageArea(): StorageArea {
  if (!sharedArea) {
    sharedArea = {
      async get(keys) {
        const wanted = typeof keys === 'string' ? [keys] : keys
        const out: Record<string, unknown> = {}
        const configKeys = wanted.filter(isConfigKey)
        const contentKeys = wanted.filter((key) => !isConfigKey(key))
        if (configKeys.length > 0) Object.assign(out, await adoptConfigKeys(configKeys))
        if (contentKeys.length === 0) return out
        const handle = await resolveHandle()
        if (handle) {
          Object.assign(out, await createFileArea(handle).get(contentKeys))
          maybeReplayInBackground(handle)
          return out
        }
        if (await isDirectoryConfigured()) {
          // Configured but unreachable: outbox → cache → legacy layers inside
          // a plain chrome.storage.local read (createFileArea's file layer is
          // skipped because the handle is down).
          Object.assign(out, await fallbackRead(contentKeys))
          return out
        }
        // Browser mode: chrome.storage.local IS the content store.
        Object.assign(out, await chromeLocalArea.get(contentKeys))
        return out
      },
      async set(items) {
        const configItems: Record<string, unknown> = {}
        const contentItems: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(items)) {
          if (value === undefined) continue
          ;(isConfigKey(key) ? configItems : contentItems)[key] = value
        }
        if (Object.keys(configItems).length > 0) {
          await chromeLocalArea.set(configItems)
          for (const key of Object.keys(configItems)) notifyStoreChanged(key)
        }
        const contentEntries = Object.entries(contentItems)
        if (contentEntries.length === 0) return
        const handle = await resolveHandle()
        if (handle) {
          await createFileArea(handle).set(contentItems)
          maybeReplayInBackground(handle)
          return
        }
        if (await isDirectoryConfigured()) {
          // The directory cannot be reached right now — park the write in the
          // durable outbox instead of misdirecting it into browser storage.
          // Reads overlay the outbox, so every later read-modify-write starts
          // from the full latest state.
          for (const [key, value] of contentEntries) await enqueueOutbox(key, value)
          for (const [key] of contentEntries) notifyStoreChanged(key)
          return
        }
        // Browser mode: chrome.storage.local IS the content store.
        await chromeLocalArea.set(contentItems)
        for (const [key] of contentEntries) notifyStoreChanged(key)
      },
      async remove(keys) {
        const wanted = typeof keys === 'string' ? [keys] : keys
        const configKeys = wanted.filter(isConfigKey)
        const contentKeys = wanted.filter((key) => !isConfigKey(key))
        if (configKeys.length > 0) {
          await chromeLocalArea.remove(configKeys)
          for (const key of configKeys) notifyStoreChanged(key)
        }
        if (contentKeys.length === 0) return
        const handle = await resolveHandle()
        if (handle) {
          await createFileArea(handle).remove(contentKeys)
          return
        }
        if (await isDirectoryConfigured()) {
          // The file cannot be reached to delete it — park a tombstone so the
          // deletion survives until the replay can carry it out, and make the
          // key read as absent meanwhile.
          for (const key of contentKeys) await enqueueOutbox(key, null)
          for (const key of contentKeys) {
            await removeCache(key).catch(() => undefined)
            await chromeLocalArea.remove(key).catch(() => undefined)
            notifyStoreChanged(key)
          }
          return
        }
        await chromeLocalArea.remove(contentKeys)
        for (const key of contentKeys) notifyStoreChanged(key)
      },
    }
  }
  return sharedArea
}

/**
 * Config keys are read from `chrome.storage.local`; if a legacy file from an
 * older version that migrated config into the directory still exists, its
 * value is adopted into browser storage once (the file is left in place —
 * deleting user files on read would be surprising).
 */
async function adoptConfigKeys(keys: string[]): Promise<Record<string, unknown>> {
  const out = await chromeLocalArea.get(keys)
  const missing = keys.filter((key) => out[key] === undefined)
  if (missing.length === 0) return out
  const handle = await resolveHandle()
  if (!handle) return out
  const fs = new FsDirectory(handle)
  for (const key of missing) {
    const text = await fs.readText(keyToPath(key))
    if (text === null) continue
    try {
      const value = JSON.parse(text) as unknown
      out[key] = value
      await chromeLocalArea.set({ [key]: value }).catch(() => undefined)
    } catch {
      // Unparsable legacy file — ignore it.
    }
  }
  return out
}

/**
 * Reads content keys while the configured directory is unreachable:
 * pending outbox entries (tombstones never fall through) → read cache →
 * any legacy mirror value.
 */
async function fallbackRead(keys: string[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const pending = await readOutboxMap()
  const unresolved: string[] = []
  for (const key of keys) {
    const entry = pending[key]
    if (!entry) {
      unresolved.push(key)
      continue
    }
    if (entry.value !== null) out[key] = entry.value
  }
  const noCache: string[] = []
  for (const key of unresolved) {
    const cached = await readCache(key)
    if (cached === undefined) noCache.push(key)
    else out[key] = cached
  }
  if (noCache.length > 0) Object.assign(out, await chromeLocalArea.get(noCache))
  return out
}

// --- Outbox replay -----------------------------------------------------------

/**
 * Drains the outbox into the directory. `value === null` entries are deletion
 * tombstones and remove the file; the skills/agents collections are flushed as
 * markdown folders (their JSON blob form only ever exists in the outbox, which
 * skipped the file area).
 */
async function replayOutboxFor(handle: FileSystemDirectoryHandle): Promise<void> {
  await replayOutbox({
    writeEntry: async (key, value) => {
      if (key === SKILLS_DIR || key === AGENTS_DIR) {
        if (!Array.isArray(value)) return
        if (key === SKILLS_DIR) await syncSkillsToFiles(value as Skill[], handle)
        else await syncAgentsToFiles(value as Agent[], handle)
        await writeCache(key, value)
        await chromeLocalArea.remove(key).catch(() => undefined)
        notifyStoreChanged(key)
        return
      }
      if (value === null) {
        await createFileArea(handle).remove(key)
        return
      }
      await createFileArea(handle).set({ [key]: value })
    },
  })
}

/** Prevents overlapping background replays in one context. */
let replayInFlight = false

/**
 * Best-effort outbox drain whenever a file operation notices that the handle
 * is usable but writes are still parked (the usual post-restart state before
 * the panel re-grants permission). Fire-and-forget: the next call retries.
 */
function maybeReplayInBackground(handle: FileSystemDirectoryHandle): void {
  if (replayInFlight) return
  replayInFlight = true
  void (async () => {
    try {
      if (Object.keys(await readOutboxMap()).length > 0) {
        await replayOutboxFor(handle)
      }
    } catch {
      // Stays parked for the next opportunity.
    } finally {
      replayInFlight = false
    }
  })()
}

/** Whether the configured directory is currently usable. */
export async function getStorageMode(): Promise<StorageMode> {
  return (await resolveHandle()) ? 'file' : 'browser'
}

/** The picked folder's name, for display; `null` when nothing is configured. */
export async function getStorageDirectoryName(): Promise<string | null> {
  try {
    const handle = await idbGet()
    return handle?.name ?? null
  } catch {
    return null
  }
}

/**
 * Re-checks the configured directory and tries to (re)grant permission when it
 * is merely pending. Returns the resulting mode.
 *
 * Re-granting is the moment writes parked in the outbox can finally reach the
 * directory, so they are flushed here — the flush is best-effort: a failure
 * must not read as "the folder is not connected", and the parked data survives
 * for the next attempt.
 */
export async function ensureFileAccess(): Promise<StorageMode> {
  if (!(await resolveHandle(true))) return 'browser'
  await syncToFiles().catch(() => undefined)
  return 'file'
}

/**
 * Shows the directory picker (window + user gesture required), remembers the
 * handle, and pushes any existing browser-stored data into the files so nothing
 * is lost. Throws when the picker is unavailable or the user cancels.
 */
export async function pickStorageDirectory(): Promise<StorageMode> {
  if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') {
    throw new Error('File System Access API is not available in this browser.')
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
  await idbPut(handle)
  resetStorageCache()
  cachedHandle = handle
  await syncToFiles()
  return 'file'
}

/**
 * Switches back to browser storage: copies the data folder into
 * `chrome.storage.local` first, then forgets the handle.
 *
 * Order matters — the copy is what makes the switch non-destructive. It throws
 * before the handle is dropped if the copy fails, so the directory is never
 * abandoned while it is the only place the data exists. Pending outbox entries
 * are folded into the copy (they are newer than the files) and the fallback
 * structures are then cleared: browser mode has no outbox and no cache.
 */
export async function clearStorageDirectory(): Promise<void> {
  await syncFilesToBrowser()
  await clearFallbacks()
  await idbDelete()
  resetStorageCache()
}

// --- Migration ---------------------------------------------------------------

/**
 * Keeps the newest version of each record: per-id union of two collection
 * arrays, the record with the larger `updatedAt`/`at` stamp winning (ties go
 * to `incoming`, the newer write). Used by the legacy-mirror migration, where
 * the browser-stored copy may be older OR newer than the file and neither may
 * be lost. Values that are not id-keyed arrays resolve to `fileValue` when one
 * exists (the file is the durable copy; `incoming` only fills a gap).
 */
export function mergeCollection(fileValue: unknown, incoming: unknown): unknown {
  if (fileValue === undefined) return incoming
  if (fileValue === null) return incoming
  if (!Array.isArray(fileValue) || !Array.isArray(incoming)) return fileValue
  const hasId = (entry: unknown): entry is { id: string } =>
    !!entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string'
  if (!fileValue.every(hasId) || !incoming.every(hasId)) return fileValue
  const stamp = (entry: unknown): number => {
    if (!entry || typeof entry !== 'object') return 0
    const record = entry as { updatedAt?: unknown; at?: unknown }
    if (typeof record.updatedAt === 'number') return record.updatedAt
    if (typeof record.at === 'number') return record.at
    return 0
  }
  const byId = new Map<string, { id: string }>()
  for (const entry of fileValue) byId.set(entry.id, entry)
  for (const entry of incoming) {
    const previous = byId.get(entry.id)
    if (!previous || stamp(entry) > stamp(previous)) byId.set(entry.id, entry)
  }
  return [...byId.values()]
}

/**
 * Pushes every content key still sitting in `chrome.storage.local` up to the
 * files. Two eras of writes land here:
 * - the pre-outbox design staged writes in browser storage and pushed them on
 *   panel open;
 * - the outbox design may hold values for keys whose outbox entry was already
 *   drained but whose mirror cleanup raced an eviction.
 *
 * Each key is MERGED with the file ({@link mergeCollection}) so a stale browser
 * copy can never regress a newer file — the exact whole-blob overwrite that
 * used to lose entire workflow lists. Idempotent: each migrated key is removed
 * from browser storage as it lands.
 */
export async function syncToFiles(): Promise<void> {
  const handle = await resolveHandle(true)
  if (!handle || !hasChromeStorage()) return
  await replayOutboxFor(handle)
  const all = (await chrome.storage.local.get(null)) as Record<string, unknown>
  for (const [key, value] of Object.entries(all)) {
    if (value === undefined) continue
    if (isConfigKey(key) || isFallbackKey(key)) continue
    // Turn state is intentionally session-scoped and never persisted as files.
    if (key.startsWith('turn:')) continue
    if (key === SKILLS_DIR || key === AGENTS_DIR) {
      if (!Array.isArray(value)) continue
      if (key === SKILLS_DIR) await syncSkillsToFiles(value as Skill[], handle)
      else await syncAgentsToFiles(value as Agent[], handle)
      await writeCache(key, value)
      await chromeLocalArea.remove(key).catch(() => undefined)
      notifyStoreChanged(key)
      continue
    }
    await syncEntriesToFiles({ [key]: value }, handle)
  }
}

/**
 * Writes each provided entry to the file area under `handle`, MERGING with the
 * current file content (see {@link mergeCollection}) and dropping the legacy
 * browser copy once it has landed. Exported so the migration rules stay
 * unit-testable with a fake handle.
 */
export async function syncEntriesToFiles(
  entries: Record<string, unknown>,
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const fs = new FsDirectory(handle)
  const area = createFileArea(handle)
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue
    if (key === SKILLS_DIR || key === AGENTS_DIR) continue
    // Session-only state is never persisted as files, no matter the caller.
    if (key.startsWith('turn:')) continue
    const text = await fs.readText(keyToPath(key))
    let fileValue: unknown
    if (text !== null) {
      try {
        fileValue = JSON.parse(text) as unknown
      } catch {
        fileValue = undefined
      }
    }
    await area.set({ [key]: mergeCollection(fileValue, value) })
  }
}

/**
 * Writes each staged skill to `skills/<slug>/SKILL.md`. Runs on first setup and
 * on panel-open sync so browser-created skills become real files like the
 * general skills on disk.
 *
 * Throws when a write fails instead of swallowing it: `syncToFiles` clears the
 * staged `skills` entry once this resolves, so a silent failure here would let
 * the only remaining copy be deleted.
 */
export async function syncSkillsToFiles(
  skills: readonly Skill[],
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const fs = new FsDirectory(handle)
  for (const skill of skills) {
    try {
      await fs.writeText(skillPath(skillSlug(skill.name)), skillToMarkdown(skill))
    } catch (error) {
      throw new Error(
        `迁移技能「${skill.name}」失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

/**
 * Writes each staged agent to `agents/<slug>/AGENT.md`, the agent counterpart of
 * {@link syncSkillsToFiles} — including its "throw rather than lose the last
 * copy" contract.
 */
export async function syncAgentsToFiles(
  agents: readonly Agent[],
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const fs = new FsDirectory(handle)
  for (const agent of agents) {
    try {
      await fs.writeText(agentPath(agentSlug(agent.name)), agentToMarkdown(agent))
    } catch (error) {
      throw new Error(
        `迁移智能体「${agent.name}」失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

/**
 * Copies everything in the data folder into `chrome.storage.local` — the reverse
 * of {@link syncToFiles}, used when the user switches back to browser storage.
 *
 * Without this the switch would look like data loss: once the handle is dropped
 * the folder is simply not read any more, so the panel would come up empty. The
 * files are never deleted, but "my conversations are gone" is not a state a user
 * should have to reason their way out of. Pending outbox entries are folded in
 * (they are newer than the files; tombstones delete their key) and the fallback
 * structures are cleared by {@link clearStorageDirectory} afterwards.
 *
 * Returns the number of keys written, and `0` when nothing is configured (browser
 * mode is already where the data lives). File names are mapped back to keys by
 * stripping the `.json` suffix, which is exact for every key the extension
 * writes — the path segment is only sanitized for keys that would be unsafe as
 * file names, and those do not occur in practice.
 */
export async function syncFilesToBrowser(): Promise<number> {
  const handle = await resolveHandle(true)
  if (!handle || !hasChromeStorage()) return 0

  const fs = new FsDirectory(handle)
  const entries: Record<string, unknown> = {}
  const collect = async (segments: string[], toKey: (name: string) => string): Promise<void> => {
    for (const name of await fs.listFiles(segments)) {
      const text = await fs.readText([...segments, name])
      if (text === null) continue
      try {
        entries[toKey(name)] = JSON.parse(text) as unknown
      } catch {
        // A corrupt file must not abort the move — everything else still lands.
      }
    }
  }

  await collect([], (name) => name.replace(/\.json$/, ''))
  await collect(['conversations'], (name) => `${CONVERSATION_PREFIX}${name.replace(/\.json$/, '')}`)
  await collect(['checkpoints'], (name) => `${CHECKPOINT_PREFIX}${name.replace(/\.json$/, '')}`)

  // Skills and agents are folder-per-entity markdown, not `<key>.json`, so they
  // are rebuilt from their folders instead of by the generic walk above.
  const skills: Skill[] = []
  for (const slug of (await fs.listSubdirectories(SKILLS_DIR)) ?? []) {
    const text = await fs.readText(skillPath(slug))
    const skill = text === null ? null : skillFromMarkdown(text)
    if (skill) skills.push(skill)
  }
  if (skills.length > 0) entries[SKILLS_DIR] = skills

  const agents: Agent[] = []
  for (const slug of (await fs.listSubdirectories(AGENTS_DIR)) ?? []) {
    const text = await fs.readText(agentPath(slug))
    const agent = text === null ? null : agentFromMarkdown(text)
    if (agent) agents.push(agent)
  }
  if (agents.length > 0) entries[AGENTS_DIR] = agents

  // Fold pending outbox entries over the file state: a parked value is newer
  // than the file, a tombstone means the key was deleted meanwhile.
  const pending = await readOutboxMap()
  for (const [key, entry] of Object.entries(pending)) {
    if (entry.value === null) delete entries[key]
    else entries[key] = entry.value
  }

  const count = Object.keys(entries).length
  if (count === 0) return 0
  await chromeLocalArea.set(entries)
  return count
}

/**
 * The granted root directory handle, or `null` when storage is unconfigured or
 * its permission is not granted. Used by the persistence modules for file-first
 * reads of structures (like skills) that do not map to a single JSON key.
 */
export async function getGrantedFsDirectory(): Promise<FileSystemDirectoryHandle | null> {
  return resolveHandle(false)
}
