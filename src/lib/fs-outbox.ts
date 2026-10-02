/**
 * Browser-storage fallback structures behind the file-backed store.
 *
 * When a storage directory is configured, content keys live in files (see
 * `lib/fs-store.ts`). The directory is not always reachable: right after a
 * browser restart the handle's permission may sit at `'prompt'`, and
 * re-granting needs a user gesture a service worker cannot provide. Two
 * structures in `chrome.storage.local` carry the store across such a gap
 * WITHOUT becoming a second copy of the data:
 *
 * - **Outbox** (`fs-outbox`): writes made while the handle is unavailable are
 *   parked here, one latest entry per key (`{ value, at }`; `value: null` is a
 *   deletion tombstone). Reads overlay the outbox over the files, so a
 *   read-modify-write always starts from the full latest state — the property
 *   whose absence made the old staging area lose whole workflow lists.
 *   {@link replayOutbox} pushes every entry into the directory once the handle
 *   is back (single-writer design: the outbox value is the newest complete
 *   state of that key, so it replaces the file wholesale) and deletes the
 *   entry only after its file write succeeded, so a service-worker eviction
 *   mid-replay resumes cleanly. Like the read cache below, the outbox is
 *   size-capped: it is rewritten WHOLE on every enqueue, so one unbounded entry
 *   (a run's checkpoints after an image step) turns into a worker-killing
 *   rewrite instead of a safety net.
 * - **Read cache** (`fs-cache:<key>`): the last value that reached a file.
 *   Purely a READ fallback for when the handle is unavailable — without it the
 *   panel would render empty lists and look like data loss. Size-capped and
 *   evicted oldest-conversation first. The cache is also how replay detects
 *   "the file already moved past this entry": a file write always stamps the
 *   cache index, so an entry older than the file's last write is dropped
 *   instead of regressing it.
 *
 * Config keys (`settings`, `schemaVersion`, …) never enter either structure —
 * they live in `chrome.storage.local` permanently by design.
 *
 * @module lib/fs-outbox
 */
import { withKeyLock } from './key-lock'

// --- chrome.storage.local accessor ---------------------------------------------

export function hasChromeStorage(): boolean {
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
export function translateStorageError(error: unknown): Error {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  if (!/quota/i.test(text)) return error instanceof Error ? error : new Error(text)
  return new Error(
    '浏览器存储空间已满，这次写入没有保存。' +
      '请在「设置 → 数据存储」里选择一个本地目录——之后对话、工作流都会存成文件，' +
      '不再受 chrome.storage.local 的上限限制；也可以先删掉一些旧对话再重试。' +
      `（Chrome 原始报错：${text}）`,
  )
}

/** The `chrome.storage.local` slice every fallback structure sits on. */
export const chromeLocalArea = {
  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    if (!hasChromeStorage()) return {}
    const stored = await chrome.storage.local.get(keys)
    return stored as Record<string, unknown>
  },
  async set(items: Record<string, unknown>): Promise<void> {
    if (!hasChromeStorage()) return
    try {
      await chrome.storage.local.set(items)
    } catch (error) {
      throw translateStorageError(error)
    }
  },
  async remove(keys: string | string[]): Promise<void> {
    if (!hasChromeStorage()) return
    await chrome.storage.local.remove(keys)
  },
}

// --- Outbox --------------------------------------------------------------------

export const OUTBOX_KEY = 'fs-outbox'

export const CACHE_PREFIX = 'fs-cache:'
export const CACHE_INDEX_KEY = 'fs-cache:index'

/**
 * Total budget for the outbox, in JSON characters. The map is rewritten WHOLE
 * on every enqueue (one `chrome.storage.local` key holds it), so its size is
 * not just a quota question: a several-hundred-megabyte rewrite starves the
 * service worker mid-write, which is how an unattended run died with every
 * other key already safe on disk.
 */
const OUTBOX_BUDGET = 8 * 1024 * 1024

/** Largest single value the outbox will carry. */
const OUTBOX_ENTRY_BUDGET = 2 * 1024 * 1024

/**
 * Past this many stored bytes the buffer is not trimmed but discarded: reading
 * a map that large back into the worker is the failure the repair exists to
 * end, and the selective path needs the whole map in hand to choose.
 */
const OUTBOX_DISCARD_LIMIT = 24 * 1024 * 1024

interface OutboxEntry {
  /** Latest value for the key; `null` marks a deletion (tombstone). */
  value: unknown
  at: number
  /**
   * JSON length of `value`, recorded at enqueue so the budget is enforced
   * without re-serializing payloads that may be megabytes. Entries written
   * before the budget existed count as 0 and roll off with their key.
   */
  bytes?: number
}

type OutboxMap = Record<string, OutboxEntry>

/**
 * The whole outbox map (key → entry). Read-side helper for overlays.
 *
 * Every fallback read goes through here, so this is where an oversized leftover
 * is refused: probing the stored size first means a buffer no worker can survive
 * reading is discarded before ANY caller asks for it, rather than depending on
 * some boot-time call winning the race against every other storage reader.
 */
export async function readOutboxMap(): Promise<OutboxMap> {
  if (await discardOversizedOutbox()) return {}
  const stored = await chromeLocalArea.get(OUTBOX_KEY)
  const raw = stored[OUTBOX_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as OutboxMap
}

/**
 * True when the buffer was past the point where reading it back is safe, and
 * has therefore just been removed. Its writes never reached the directory
 * either, so what is lost is the gap back to the last state that landed on
 * disk — which is exactly what a worker killed mid-read would cost anyway.
 */
async function discardOversizedOutbox(): Promise<boolean> {
  const used = await outboxBytesInUse()
  if (used === undefined || used <= OUTBOX_DISCARD_LIMIT) return false
  await chromeLocalArea.remove(OUTBOX_KEY)
  console.warn(`[fs-outbox] ${used} bytes parked past the recoverable limit — buffer discarded`)
  return true
}

/**
 * Parks a write in the outbox. One entry per key — a newer write for the same
 * key replaces the older one, so a burst of writes during an outage costs one
 * entry, not many. Serialized on the outbox key itself so two concurrent
 * enqueues cannot drop one another's entry.
 *
 * Bounded: an entry over {@link OUTBOX_ENTRY_BUDGET} is refused (the write
 * stays lost, as it would be with no fallback at all — but parking it would
 * take the whole worker down with it), and past {@link OUTBOX_BUDGET} entries
 * are evicted cheapest-first: checkpoints before transcripts before anything
 * structural, oldest within each class. The entry just written is never the
 * victim.
 */
export async function enqueueOutbox(key: string, value: unknown): Promise<void> {
  let bytes: number
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return
    bytes = text.length
  } catch {
    return
  }
  if (bytes > OUTBOX_ENTRY_BUDGET) {
    console.warn(`[fs-outbox] ${key} (${bytes} chars) exceeds the buffer limit; dropped`)
    return
  }
  await withKeyLock(OUTBOX_KEY, async () => {
    const all = await readOutboxMap()
    all[key] = { value, at: Date.now(), bytes }
    let total = totalBytes(all)
    while (total > OUTBOX_BUDGET) {
      const victim = cheapestVictim(all, key)
      if (!victim) break
      total -= all[victim]?.bytes ?? 0
      delete all[victim]
    }
    await chromeLocalArea.set({ [OUTBOX_KEY]: all })
  })
}

/** Checkpoints are a resume optimization, transcripts next, the rest structural. */
function evictionClass(key: string): number {
  if (key.startsWith('cp:')) return 0
  if (key.startsWith('conv:')) return 1
  return 2
}

function totalBytes(all: OutboxMap): number {
  let total = 0
  for (const entry of Object.values(all)) total += entry?.bytes ?? 0
  return total
}

/** The key to evict to make room: lowest class, then oldest. Never `keep`. */
function cheapestVictim(all: OutboxMap, keep: string): string | undefined {
  let best: string | undefined
  let bestClass = Number.POSITIVE_INFINITY
  let bestAt = Number.POSITIVE_INFINITY
  for (const [key, entry] of Object.entries(all)) {
    if (key === keep) continue
    const classOf = evictionClass(key)
    const at = entry?.at ?? 0
    if (classOf < bestClass || (classOf === bestClass && at < bestAt)) {
      best = key
      bestClass = classOf
      bestAt = at
    }
  }
  return best
}

/**
 * Repair an outbox a build WITHOUT the cap may have left behind: the buffer
 * itself is already handled by {@link readOutboxMap} (oversized ⇒ discarded
 * before anyone reads it), so what is left to do is shed the fat-but-readable
 * remainder. Checkpoints go first — they are the class that grew, and the class
 * that is safe to lose, checkpoints being a resume optimization — then ordinary
 * budget eviction. Called at worker start; later writes carry `bytes`, so the
 * enqueue's own budget keeps it small from then on.
 */
export async function trimOutboxToBudget(): Promise<void> {
  let dropped = 0
  await withKeyLock(OUTBOX_KEY, async () => {
    const all = await readOutboxMap()
    for (const [key, entry] of Object.entries(all)) {
      if (entry && typeof entry.bytes !== 'number' && evictionClass(key) === 0) {
        delete all[key]
        dropped += 1
      }
    }
    let total = totalBytes(all)
    while (total > OUTBOX_BUDGET) {
      const victim = cheapestVictim(all, '')
      if (!victim) break
      total -= all[victim]?.bytes ?? 0
      delete all[victim]
      dropped += 1
    }
    if (dropped === 0) return
    await chromeLocalArea.set({ [OUTBOX_KEY]: all })
  })
  if (dropped > 0) console.warn(`[fs-outbox] shed ${dropped} over-budget key(s)`)
}

/**
 * Bytes `chrome.storage.local` spends on the outbox map, or `undefined` where
 * the API is unavailable (browser mode without chrome, tests without a mock).
 */
async function outboxBytesInUse(): Promise<number | undefined> {
  if (!hasChromeStorage()) return undefined
  try {
    return await chrome.storage.local.getBytesInUse(OUTBOX_KEY)
  } catch {
    return undefined
  }
}

/** Number of keys currently parked in the outbox (for the settings badge). */
export async function outboxCount(): Promise<number> {
  return Object.keys(await readOutboxMap()).length
}

/**
 * Returns the pending entry for `key`, or `undefined`. Used by the read path
 * to overlay pending writes (and deletion tombstones) over the file state.
 */
export async function readOutboxEntry(key: string): Promise<OutboxEntry | undefined> {
  const all = await readOutboxMap()
  return all[key]
}

export interface OutboxHandlers {
  /**
   * Lands one outbox entry in the directory. `value === null` means the key
   * was deleted while the handle was unavailable — the file must go.
   */
  writeEntry(key: string, value: unknown): Promise<void>
}

/**
 * Drains the outbox into the directory, oldest entry first.
 *
 * Each entry is guarded: if the file already holds a NEWER version (its cache
 * stamp is past the entry's `at`, meaning the write that parked this entry was
 * superseded by a direct file write once the handle returned) the entry is
 * dropped instead of regressing the file. Entries are deleted only after their
 * write (or drop) resolves, and only when no newer write replaced them in the
 * meantime, so an eviction mid-replay resumes on the next call. One failing
 * key is left parked and the rest still drain — a single bad key must not
 * strand every other pending write.
 *
 * Locking is per entry, never around the whole drain: the file-area writes
 * below drop the outbox entry they just landed (see `createFileArea`), which
 * takes the outbox queue itself — holding that queue across the drain would
 * deadlock against it.
 */
export async function replayOutbox(handlers: OutboxHandlers): Promise<void> {
  const keys = Object.keys(await readOutboxMap())
  // Oldest first so a key written repeatedly during an outage replays in order.
  const atByKey = await readOutboxMap()
  keys.sort((a, b) => (atByKey[a]?.at ?? 0) - (atByKey[b]?.at ?? 0))
  for (const key of keys) {
    let entryAt: number
    let value: unknown
    try {
      // Re-read per key: a concurrent replay or a newer enqueue may have
      // changed or removed it since the snapshot above.
      const current = (await readOutboxMap())[key]
      if (!current) continue
      entryAt = current.at
      value = current.value
      if (!(await fileIsNewerThan(key, entryAt))) {
        await withKeyLock(key, () => handlers.writeEntry(key, value))
      }
    } catch {
      // Leave the entry parked for the next replay; keep draining the rest.
      continue
    }
    // Delete exactly this entry: a newer enqueue that landed while the write
    // was in flight has a different `at` and must survive for the next replay.
    await withKeyLock(OUTBOX_KEY, async () => {
      const all = await readOutboxMap()
      const current = all[key]
      if (!current || current.at !== entryAt) return
      delete all[key]
      await chromeLocalArea.set({ [OUTBOX_KEY]: all })
    })
  }
}

// --- Read cache ----------------------------------------------------------------

/** Total budget for the read cache (5 MB of JSON text). */
const CACHE_BUDGET = 5 * 1024 * 1024

interface CacheIndex {
  [key: string]: { at: number; bytes: number }
}

async function readCacheIndex(): Promise<CacheIndex> {
  const stored = await chromeLocalArea.get(CACHE_INDEX_KEY)
  const raw = stored[CACHE_INDEX_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as CacheIndex
}

/**
 * Whether the file for `key` was last written AFTER `at`. The cache index is
 * stamped on every successful file write, so its `at` is a stand-in for the
 * file's version time (the file system itself exposes no mtime through the
 * File System Access API).
 */
async function fileIsNewerThan(key: string, at: number): Promise<boolean> {
  const index = await readCacheIndex()
  return (index[key]?.at ?? 0) > at
}

/**
 * Records `value` as the last-known file state of `key` (best effort: a cache
 * failure must never fail the file write that just succeeded). Oversize values
 * are skipped rather than cached. Past the total budget the OLDEST cached
 * conversation is evicted first — transcripts are the largest and least
 * structural entries; collections stay as long as possible.
 */
export async function writeCache(key: string, value: unknown): Promise<void> {
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return
    const bytes = text.length
    if (bytes > CACHE_BUDGET / 4) return
    await chromeLocalArea.set({ [`${CACHE_PREFIX}${key}`]: value })
    const index = await readCacheIndex()
    index[key] = { at: Date.now(), bytes }
    // Evict oldest-first, conversations before collections, never the fresh entry.
    let total = Object.values(index).reduce((sum, entry) => sum + (entry?.bytes ?? 0), 0)
    while (total > CACHE_BUDGET) {
      const victim = Object.entries(index)
        .filter(([entryKey]) => entryKey !== key)
        .sort((a, b) => {
          const aConv = a[0].startsWith('conv:') || a[0].startsWith('cp:') ? 0 : 1
          const bConv = b[0].startsWith('conv:') || b[0].startsWith('cp:') ? 0 : 1
          if (aConv !== bConv) return aConv - bConv
          return (a[1]?.at ?? 0) - (b[1]?.at ?? 0)
        })[0]
      if (!victim) break
      const [victimKey, victimEntry] = victim
      total -= victimEntry?.bytes ?? 0
      delete index[victimKey]
      await chromeLocalArea.remove(`${CACHE_PREFIX}${victimKey}`)
    }
    await chromeLocalArea.set({ [CACHE_INDEX_KEY]: index })
  } catch {
    // The cache is a read-side convenience only.
  }
}

/** The last-known file state of `key`, or `undefined` when nothing is cached. */
export async function readCache(key: string): Promise<unknown> {
  const stored = await chromeLocalArea.get(`${CACHE_PREFIX}${key}`)
  return stored[`${CACHE_PREFIX}${key}`]
}

/** Removes the cached copy of `key` (after a file deletion). */
export async function removeCache(key: string): Promise<void> {
  try {
    await chromeLocalArea.remove(`${CACHE_PREFIX}${key}`)
    const index = await readCacheIndex()
    delete index[key]
    await chromeLocalArea.set({ [CACHE_INDEX_KEY]: index })
  } catch {
    // Best effort.
  }
}

/**
 * Removes any parked entry for `key`. Used when a key is deleted while the
 * handle IS available: a stale pending write for a just-deleted key must not
 * resurrect it on the next replay.
 */
export async function dropOutboxEntry(key: string): Promise<void> {
  await withKeyLock(OUTBOX_KEY, async () => {
    const all = await readOutboxMap()
    if (!(key in all)) return
    delete all[key]
    await chromeLocalArea.set({ [OUTBOX_KEY]: all })
  })
}

/**
 * Removes the outbox and every cache entry (used when leaving file mode).
 *
 * Enumerates through the cache index rather than `get(null)`: this runs after
 * {@link syncFilesToBrowser} has folded the pending writes back in, so nothing
 * here needs to SEE the stored values — and a whole-store read would
 * deserialize whatever size the pre-budget builds left behind, which is the
 * exact read that takes a worker down. Keys are removed by name instead.
 */
export async function clearFallbacks(): Promise<void> {
  try {
    const stale = [OUTBOX_KEY, CACHE_INDEX_KEY]
    for (const key of Object.keys(await readCacheIndex())) stale.push(`${CACHE_PREFIX}${key}`)
    await chromeLocalArea.remove(stale)
  } catch {
    // Best effort.
  }
}
