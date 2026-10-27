/**
 * Panel-side updater state: the last check result, the dismissed version and
 * the "files are written, waiting for a reload" marker.
 *
 * These are extension configuration, not user content, so they live in
 * `chrome.storage.local` directly (the fs-store config keyspace).
 *
 * @module lib/update/state
 */

import {
  UPDATE_BACKUP_KEY,
  UPDATE_DISMISSED_KEY,
  UPDATE_PENDING_KEY,
  UPDATE_STATE_KEY,
  type UpdateBackup,
  type UpdateState,
} from './types'
import { isNewerVersion } from './version'

export async function readStoredUpdateState(): Promise<UpdateState | null> {
  try {
    const stored = await chrome.storage.local.get(UPDATE_STATE_KEY)
    return (stored[UPDATE_STATE_KEY] as UpdateState | undefined) ?? null
  } catch {
    return null
  }
}

export async function readDismissedVersion(): Promise<string | null> {
  try {
    const stored = await chrome.storage.local.get(UPDATE_DISMISSED_KEY)
    const version = stored[UPDATE_DISMISSED_KEY]
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

export async function dismissUpdateVersion(version: string): Promise<void> {
  await chrome.storage.local.set({ [UPDATE_DISMISSED_KEY]: version })
}

export async function markPendingReload(version: string): Promise<void> {
  await chrome.storage.local.set({ [UPDATE_PENDING_KEY]: version })
}

export async function clearPendingReload(): Promise<void> {
  await chrome.storage.local.remove(UPDATE_PENDING_KEY)
}

export async function readUpdateBackups(): Promise<UpdateBackup[]> {
  try {
    const stored = await chrome.storage.local.get(UPDATE_BACKUP_KEY)
    const list = stored[UPDATE_BACKUP_KEY]
    if (!Array.isArray(list)) return []
    return list.filter(
      (item): item is UpdateBackup =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as UpdateBackup).folder === 'string' &&
        typeof (item as UpdateBackup).version === 'string',
    )
  } catch {
    return []
  }
}

/** Records a backup to delete once `version` is the build that is running. */
export async function addUpdateBackup(backup: UpdateBackup): Promise<void> {
  const list = await readUpdateBackups()
  const next = [...list.filter((item) => item.folder !== backup.folder), backup]
  await chrome.storage.local.set({ [UPDATE_BACKUP_KEY]: next })
}

export async function removeUpdateBackup(folder: string): Promise<void> {
  const list = await readUpdateBackups()
  const next = list.filter((item) => item.folder !== folder)
  if (next.length === 0) await chrome.storage.local.remove(UPDATE_BACKUP_KEY)
  else await chrome.storage.local.set({ [UPDATE_BACKUP_KEY]: next })
}

/**
 * Returns the version whose files are on disk but not loaded yet, or `null`.
 * Once the running version reaches the pending one, the marker is removed:
 * the reload happened (or the panel was reloaded manually after it).
 */
export async function readPendingReloadVersion(currentVersion: string): Promise<string | null> {
  try {
    const stored = await chrome.storage.local.get(UPDATE_PENDING_KEY)
    const pending = stored[UPDATE_PENDING_KEY]
    if (typeof pending !== 'string') return null
    if (!isNewerVersion(pending, currentVersion)) {
      await clearPendingReload()
      return null
    }
    return pending
  } catch {
    return null
  }
}

export type InstallType = 'development' | 'normal' | 'sideload' | 'admin' | 'other'

/** `chrome.management.getSelf()` needs no permission; failures mean "not updatable". */
export async function getInstallType(): Promise<InstallType> {
  try {
    const self = await chrome.management.getSelf()
    return (self.installType as InstallType | undefined) ?? 'other'
  } catch {
    return 'other'
  }
}

/**
 * The in-place updater is only offered for a real "Load unpacked" install with
 * the File System Access API. CWS/sideloaded/enterprise copies keep Chrome's
 * own update path and only get a link to the release page.
 */
export function canApplyInPlace(installType: InstallType): boolean {
  return (
    installType === 'development' &&
    typeof window !== 'undefined' &&
    typeof window.showDirectoryPicker === 'function'
  )
}
