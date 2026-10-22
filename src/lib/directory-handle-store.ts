/**
 * IndexedDB persistence for File System Access directory handles.
 *
 * One database (`browser-copilot-fs`) and one object store (`directory`) hold
 * every long-lived handle, keyed by purpose:
 * - `root` — the user's file-storage folder (`lib/fs-store`)
 * - `download` — the configured download folder (`lib/download-dir`)
 * - `install` — the unpacked extension's own install folder (`lib/update`)
 *
 * Keeping the keys in one store means a handle granted once stays readable
 * after a restart as long as the browser keeps the permission; it also avoids
 * a second IndexedDB schema for each new picker.
 *
 * @module lib/directory-handle-store
 */

export const DIRECTORY_DATABASE = 'browser-copilot-fs'
export const DIRECTORY_STORE = 'directory'

function openDirectoryDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'))
      return
    }
    const request = indexedDB.open(DIRECTORY_DATABASE, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DIRECTORY_STORE)) {
        request.result.createObjectStore(DIRECTORY_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
  })
}

/** Reads one stored handle; `null` when absent or IndexedDB is unavailable. */
export async function readDirectoryHandle(key: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDirectoryDatabase()
    return await new Promise((resolve) => {
      const tx = db.transaction(DIRECTORY_STORE, 'readonly')
      const request = tx.objectStore(DIRECTORY_STORE).get(key)
      request.onsuccess = () =>
        resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null)
      request.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

/** Stores (or replaces) one handle. Rejects when IndexedDB is unavailable. */
export async function writeDirectoryHandle(
  key: string,
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const db = await openDirectoryDatabase()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DIRECTORY_STORE, 'readwrite')
    tx.objectStore(DIRECTORY_STORE).put(handle, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
  })
}

/** Forgets one handle; deleting an absent key (or without IndexedDB) is a no-op. */
export async function deleteDirectoryHandle(key: string): Promise<void> {
  try {
    const db = await openDirectoryDatabase()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(DIRECTORY_STORE, 'readwrite')
      tx.objectStore(DIRECTORY_STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    // Nothing stored — nothing to clear.
  }
}
