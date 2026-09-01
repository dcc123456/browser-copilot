/**
 * File-backed storage.
 *
 * The durable copy of every setting / conversation / task / workflow lives in
 * plain JSON files on the user's hard drive instead of inside
 * `chrome.storage.local`. The user picks a directory once via the File System
 * Access API (`showDirectoryPicker`); the directory handle is persisted in
 * IndexedDB, and a `browser-copilot` subfolder inside it holds one JSON file per
 * logical key (conversation transcripts under `conversations/<id>.json`).
 *
 * `chrome.storage.local` is demoted to a mirror: every write is also written
 * there so the service worker keeps a consistent, fast view even when the file
 * handle is momentarily unusable — re-requesting a dropped permission needs a
 * user gesture, which a background worker cannot provide. Reads prefer the file
 * when the handle is granted and fall back to the mirror only when a file is
 * absent or corrupt, so externally-edited files are picked up and nothing is
 * lost in the gap between choosing a directory and the first grant. The mirror
 * is also what fires `chrome.storage.onChanged` for the UI.
 *
 * The picker and permission requests require a window plus a user gesture, so
 * those entry points (`pickStorageDirectory`, `ensureFileAccess`, `syncToFiles`)
 * run in the side panel. The service worker only consumes the handle: reads and
 * writes succeed as long as the permission is already granted for this
 * extension's origin (which it is once the user has chosen the directory).
 *
 * @module lib/fs-store
 */
import { skillSlug, skillToMarkdown } from './skills-import'
import type { Skill } from './types'

/**
 * Subfolder inside the picked directory that holds the JSON data files.
 * A fixed name keeps the extension's data from mixing with the user's own
 * files when they point us at a folder they already use.
 */
export const DATA_DIR = 'browser-copilot'

/** The keyspace prefix for a conversation transcript (see `lib/storage.ts`). */
const CONVERSATION_PREFIX = 'conv:'

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

// --- Key → file mapping ------------------------------------------------------

/** Replaces characters that are unsafe in a file name. Keys are code-controlled,
 *  so this is defensive, not a trust boundary. */
function sanitizeFileSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, '_') || 'key'
}

/**
 * Maps a logical storage key to the file path segments under the data folder.
 *
 * `conv:<id>` transcripts go to `conversations/<id>.json` so a long chat does
 * not sit in the root next to settings; every other key becomes `<key>.json`.
 * Exported for direct testing.
 */
export function keyToPath(key: string): string[] {
  if (key.startsWith(CONVERSATION_PREFIX)) {
    return ['conversations', `${sanitizeFileSegment(key.slice(CONVERSATION_PREFIX.length))}.json`]
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
      handle = await handle.getDirectoryHandle(segment, { create })
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

  /** Creates or overwrites a file with the given text. */
  async writeText(segments: string[], text: string): Promise<void> {
    const fileHandle = await this.fileHandle(segments, true)
    if (!fileHandle) return
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

// --- chrome.storage.local mirror ---------------------------------------------

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.storage?.local
}

const chromeArea: StorageArea = {
  async get(keys) {
    if (!hasChromeStorage()) return {}
    const stored = await chrome.storage.local.get(keys)
    return stored as Record<string, unknown>
  },
  async set(items) {
    if (!hasChromeStorage()) return
    await chrome.storage.local.set(items)
  },
  async remove(keys) {
    if (!hasChromeStorage()) return
    await chrome.storage.local.remove(keys)
  },
}

// --- File-backed area --------------------------------------------------------

/**
 * A `StorageArea` backed by real files. Reads that miss a file (first run before
 * migration, a corrupt record) fall back to the mirror; writes always mirror to
 * `chrome.storage.local` so the cache stays a consistent fast copy.
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
          // Corrupt file — fall back to the mirror rather than surfacing an
          // unparsable value to a caller that trusts the shape.
          missing.push(key)
        }
      }
      if (missing.length > 0) Object.assign(out, await chromeArea.get(missing))
      return out
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        // Skills live as `skills/<slug>/SKILL.md` files, not as a JSON blob in
        // the data folder; `storage.ts` writes those files directly.
        if (key === SKILLS_DIR) continue
        try {
          await fs.writeText(keyToPath(key), JSON.stringify(value))
        } catch {
          // Best-effort: the mirror below still records the value, so the data
          // is not lost even if the disk write fails mid-flight.
        }
      }
      await chromeArea.set(items).catch(() => {})
    },
    async remove(keys) {
      const wanted = typeof keys === 'string' ? [keys] : keys
      for (const key of wanted) await fs.remove(keyToPath(key))
      await chromeArea.remove(wanted).catch(() => {})
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
 * `null` (falling back to the mirror) instead of hanging.
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

// --- Public entry points -----------------------------------------------------

/**
 * The storage area used by the persistence modules. Resolves the configured
 * directory on every call and falls back to the `chrome.storage.local` mirror
 * when it is absent or not granted. A single instance is fine because the
 * backing choice is made per call.
 */
let sharedArea: StorageArea | null = null

export function fileStorageArea(): StorageArea {
  if (!sharedArea) {
    sharedArea = {
      async get(keys) {
        const handle = await resolveHandle()
        return handle ? createFileArea(handle).get(keys) : chromeArea.get(keys)
      },
      async set(items) {
        const handle = await resolveHandle()
        if (handle) await createFileArea(handle).set(items)
        else await chromeArea.set(items)
      },
      async remove(keys) {
        const handle = await resolveHandle()
        if (handle) await createFileArea(handle).remove(keys)
        else await chromeArea.remove(keys)
      },
    }
  }
  return sharedArea
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
 */
export async function ensureFileAccess(): Promise<StorageMode> {
  return (await resolveHandle(true)) ? 'file' : 'browser'
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

/** Forgets the directory handle (files already written stay on disk). */
export async function clearStorageDirectory(): Promise<void> {
  await idbDelete()
  resetStorageCache()
}

/**
 * Pushes every key currently in `chrome.storage.local` up to the files. Used to
 * migrate on first setup and to compensate for writes the service worker made
 * while the file handle was unavailable. Idempotent. Skills are synced
 * separately as folder-per-skill `SKILL.md` files (see {@link syncSkillsToFiles}).
 */
export async function syncToFiles(): Promise<void> {
  const handle = await resolveHandle(true)
  if (!handle || !hasChromeStorage()) return
  const all = await chrome.storage.local.get(null)
  await syncEntriesToFiles(all as Record<string, unknown>, handle)
  const skills = (all as Record<string, unknown>)[SKILLS_DIR]
  if (Array.isArray(skills)) {
    await syncSkillsToFiles(skills as Skill[], handle)
  }
}

/**
 * Writes each provided entry to the file area under `handle`, skipping values
 * that must not be persisted: `undefined` (not representable), session-only
 * `turn:` state, and the `skills` key (skills are written as `SKILL.md` files
 * via {@link syncSkillsToFiles}). `createFileArea.set` also re-mirrors each
 * entry to `chrome.storage.local`, so this is idempotent and safe to re-run.
 * Extracted from `syncToFiles` so the migration path is testable with a fake
 * handle.
 */
export async function syncEntriesToFiles(
  entries: Record<string, unknown>,
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const area = createFileArea(handle)
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue
    // Turn state is intentionally session-scoped and never persisted as files.
    if (key.startsWith('turn:')) continue
    // Skills are persisted as markdown files, not as a JSON blob.
    if (key === SKILLS_DIR) continue
    await area.set({ [key]: value })
  }
}

/**
 * Writes each mirrored skill to `skills/<slug>/SKILL.md` (idempotent, best
 * effort). Runs on first setup and on panel-open sync so browser-created skills
 * become real files like the general skills on disk.
 */
export async function syncSkillsToFiles(
  skills: readonly Skill[],
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const fs = new FsDirectory(handle)
  for (const skill of skills) {
    try {
      await fs.writeText(skillPath(skillSlug(skill.name)), skillToMarkdown(skill))
    } catch {
      // Best-effort during migration; the mirror still holds the value.
    }
  }
}

/**
 * The granted root directory handle, or `null` when storage is unconfigured or
 * its permission is not granted. Used by the persistence modules for file-first
 * reads of structures (like skills) that do not map to a single JSON key.
 */
export async function getGrantedFsDirectory(): Promise<FileSystemDirectoryHandle | null> {
  return resolveHandle(false)
}
