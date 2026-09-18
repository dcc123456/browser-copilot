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
 * `chrome.storage.local` is NOT a second copy of the data. Once a directory is
 * configured, writes go to files only: the user asked for their data to live in
 * that directory and nowhere else, and a full mirror is exactly what filled the
 * store's 10 MB quota. What remains in `chrome.storage.local` is a narrow
 * staging area for the one case a file write cannot serve — a write made while
 * the handle is unavailable, since re-requesting a dropped permission needs a
 * user gesture that a background worker cannot provide. Such a write lands in
 * the mirror, is readable from there until it is flushed, and is pushed into
 * files by {@link syncToFiles} on the next panel open. A key that reaches a file
 * is removed from the mirror, so the staging area only ever holds writes that
 * have not landed yet.
 *
 * Reads still prefer the file when the handle is granted and fall back to the
 * mirror otherwise, so externally-edited files are picked up and a pending write
 * is not lost in the gap between choosing a directory and the first grant.
 *
 * `chrome.storage.onChanged` used to be how the UI learned about a write. That
 * store is no longer written, so `lib/store-events` carries the notification
 * instead.
 *
 * The picker and permission requests require a window plus a user gesture, so
 * those entry points (`pickStorageDirectory`, `ensureFileAccess`, `syncToFiles`)
 * run in the side panel. The service worker only consumes the handle: reads and
 * writes succeed as long as the permission is already granted for this
 * extension's origin (which it is once the user has chosen the directory).
 *
 * @module lib/fs-store
 */
import { skillFromMarkdown, skillSlug, skillToMarkdown } from './skills-import'
import { agentFromMarkdown, agentSlug, agentToMarkdown } from './agents-import'
import { notifyStoreChanged } from './store-events'
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

// --- chrome.storage.local mirror ---------------------------------------------

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.storage?.local
}

/**
 * Chrome refuses a `storage.local` write past its quota with
 * `Resource::kQuotaBytes quota exceeded` — a message naming an internal
 * constant that suggests nothing. Since this string is exactly what a user sees
 * when a save fails, it is replaced with the two things that actually help.
 *
 * The `unlimitedStorage` permission lifts the cap (see `manifest.config.ts`), so
 * reaching here means either the permission is missing or a real disk limit was
 * hit; in both cases moving the data into files is the way out. Non-quota
 * errors pass through untouched — translating them would hide the real cause.
 */
function translateStorageError(error: unknown): Error {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  if (!/quota/i.test(text)) return error instanceof Error ? error : new Error(text)
  return new Error(
    '浏览器存储空间已满，这次写入没有保存。' +
      '请在「设置 → 数据存储」里选择一个本地目录——之后对话、工作流都会存成文件，' +
      '不再受 chrome.storage.local 的上限限制；也可以先删掉一些旧对话再重试。' +
      `（Chrome 原始报错：${text}）`,
  )
}

const chromeArea: StorageArea = {
  async get(keys) {
    if (!hasChromeStorage()) return {}
    const stored = await chrome.storage.local.get(keys)
    return stored as Record<string, unknown>
  },
  async set(items) {
    if (!hasChromeStorage()) return
    try {
      await chrome.storage.local.set(items)
    } catch (error) {
      throw translateStorageError(error)
    }
  },
  async remove(keys) {
    if (!hasChromeStorage()) return
    await chrome.storage.local.remove(keys)
  },
}

// --- File-backed area --------------------------------------------------------

/**
 * A `StorageArea` backed by real files. Writes go to files only and announce
 * themselves through `lib/store-events`; a read that misses a file falls back to
 * the `chrome.storage.local` staging area, which by then holds only writes made
 * while the handle was unavailable (see the module note).
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
          // Corrupt file — fall back to the staging area rather than surfacing
          // an unparsable value to a caller that trusts the shape.
          missing.push(key)
        }
      }
      if (missing.length > 0) Object.assign(out, await chromeArea.get(missing))
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
          // A failed disk write must be visible. It used to be swallowed because
          // the mirror still held the value; there is no full mirror any more,
          // so silence here would be silent data loss.
          throw new Error(
            `写入存储目录失败（${key}）：${error instanceof Error ? error.message : String(error)}。` +
              '请确认该目录仍然存在、且扩展仍有读写权限——在「设置 → 数据存储」里可以重新连接。',
          )
        }
        written.push(key)
      }
      if (written.length === 0) return
      // Drop any staged copy of a key that just landed on disk. Without this the
      // staging area could keep an older value for the same key, and the next
      // `syncToFiles` would push that stale value over the newer file.
      await chromeArea.remove(written).catch(() => {})
      for (const key of written) notifyStoreChanged(key)
    },
    async remove(keys) {
      const wanted = typeof keys === 'string' ? [keys] : keys
      for (const key of wanted) await fs.remove(keyToPath(key))
      // Clear the staging area BEFORE notifying: a listener that re-reads must
      // not find the deleted value still sitting in the read fallback.
      await chromeArea.remove(wanted).catch(() => {})
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
 * directory on every call, and falls back to `chrome.storage.local` when it is
 * absent or not granted — either because no directory is configured (browser
 * mode, the store *is* the data) or because the handle is momentarily
 * unavailable (the write is staged there until {@link syncToFiles} flushes it).
 * A single instance is fine because the backing choice is made per call.
 *
 * Notifications are emitted here on the fallback path only: `createFileArea`
 * announces its own writes.
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
        if (handle) {
          await createFileArea(handle).set(items)
          return
        }
        await chromeArea.set(items)
        for (const key of Object.keys(items)) notifyStoreChanged(key)
      },
      async remove(keys) {
        const handle = await resolveHandle()
        if (handle) {
          await createFileArea(handle).remove(keys)
          return
        }
        const wanted = typeof keys === 'string' ? [keys] : keys
        await chromeArea.remove(wanted)
        for (const key of wanted) notifyStoreChanged(key)
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
 *
 * Re-granting is the moment writes staged while the handle was unavailable can
 * finally reach the directory, so they are flushed here — otherwise they would
 * linger in `chrome.storage.local` until the next panel open. The flush is
 * best-effort, matching its other call site: a failure must not read as "the
 * folder is not connected", and the staged data survives for the next attempt.
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
 * abandoned while it is the only place the data exists.
 */
export async function clearStorageDirectory(): Promise<void> {
  await syncFilesToBrowser()
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
  const all = (await chrome.storage.local.get(null)) as Record<string, unknown>
  // Each migrated key is dropped from the staging area as it lands on disk, so
  // re-running cannot push an already-migrated value again.
  await syncEntriesToFiles(all, handle)
  // Skills and agents are written as markdown files, never as a JSON blob, so
  // `syncEntriesToFiles` skipped them and they are still staged. Clear them once
  // they are on disk — otherwise they would sit in the browser store forever,
  // which is the very thing this migration exists to avoid.
  const skills = all[SKILLS_DIR]
  if (Array.isArray(skills)) {
    await syncSkillsToFiles(skills as Skill[], handle)
    await chromeArea.remove(SKILLS_DIR)
  }
  const agents = all[AGENTS_DIR]
  if (Array.isArray(agents)) {
    await syncAgentsToFiles(agents as Agent[], handle)
    await chromeArea.remove(AGENTS_DIR)
  }
}

/**
 * Writes each provided entry to the file area under `handle` and drops it from
 * the `chrome.storage.local` staging area (see `createFileArea.set`), skipping
 * values that must not be persisted: `undefined` (not representable),
 * session-only `turn:` state, and the `skills`/`agents` keys (those are written
 * as `SKILL.md` / `AGENT.md` files by {@link syncSkillsToFiles} and
 * {@link syncAgentsToFiles}). Extracted from `syncToFiles` so the migration path
 * is testable with a fake handle.
 */
export async function syncEntriesToFiles(
  entries: Record<string, unknown>,
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const area = createFileArea(handle)
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue
    // Turn state is intentionally session-scoped and never persisted as files.
    // Skills/agents are persisted as markdown files, not as a JSON blob.
    if (key.startsWith('turn:')) continue
    if (key === SKILLS_DIR || key === AGENTS_DIR) continue
    await area.set({ [key]: value })
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
 * should have to reason their way out of.
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

  const count = Object.keys(entries).length
  if (count === 0) return 0
  await chromeArea.set(entries)
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
