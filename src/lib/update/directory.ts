/**
 * Install-directory handles for the in-place updater.
 *
 * The picker and `requestPermission` need a window and a user gesture, so this
 * module is panel-only. The handle is persisted under its own IndexedDB key so
 * it never collides with the user's file-storage or download folders.
 *
 * @module lib/update/directory
 */

import {
  deleteDirectoryHandle,
  readDirectoryHandle,
  writeDirectoryHandle,
} from '../directory-handle-store'
import { validateInstallFolderManifest, type FolderManifestExpectation } from './install-plan'
import { UpdateApplyError } from './types'

export const INSTALL_DIRECTORY_KEY = 'install'

const PICKER_ID = 'browser-copilot-install'

/** The saved install folder, or `null` when absent or no longer writable. */
export async function resolveInstallDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await readDirectoryHandle(INSTALL_DIRECTORY_KEY)
  if (!handle) return null
  try {
    let permission = await handle.queryPermission({ mode: 'readwrite' })
    if (permission === 'prompt' && typeof handle.requestPermission === 'function') {
      permission = await handle.requestPermission({ mode: 'readwrite' })
    }
    return permission === 'granted' ? handle : null
  } catch {
    return null
  }
}

export interface SavedInstallDirectory {
  handle: FileSystemDirectoryHandle
  name: string
  /**
   * Query-only, so opening the dialog never triggers a permission prompt.
   * `prompt` still means the saved folder may be reused from a click handler.
   */
  permission: PermissionState
}

/** Read-only view of the remembered folder, for labeling the dialog. */
export async function peekInstallDirectory(): Promise<SavedInstallDirectory | null> {
  const handle = await readDirectoryHandle(INSTALL_DIRECTORY_KEY)
  if (!handle) return null
  let permission: PermissionState = 'denied'
  try {
    permission = await handle.queryPermission({ mode: 'readwrite' })
  } catch {
    // No permission API: treat as needing an explicit re-pick.
  }
  return { handle, name: handle.name, permission }
}

/**
 * Opens the native directory picker. Returns `null` when the user cancels;
 * throws `not-development-install`, `picker-failed` or `permission-denied`
 * otherwise. Must be called synchronously from a click handler.
 */
export async function pickInstallDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') {
    throw new UpdateApplyError(
      'not-development-install',
      'This browser cannot write to a folder from the extension.',
    )
  }
  let handle: FileSystemDirectoryHandle
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite', id: PICKER_ID })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null
    throw new UpdateApplyError(
      'picker-failed',
      error instanceof Error ? error.message : 'The folder picker failed.',
    )
  }
  try {
    const permission = await handle.queryPermission({ mode: 'readwrite' })
    if (permission !== 'granted') {
      throw new UpdateApplyError('permission-denied', 'Read-write permission was not granted.')
    }
  } catch (error) {
    if (error instanceof UpdateApplyError) throw error
    throw new UpdateApplyError('permission-denied', 'Read-write permission could not be verified.')
  }
  return handle
}

export function rememberInstallDirectory(handle: FileSystemDirectoryHandle): Promise<void> {
  return writeDirectoryHandle(INSTALL_DIRECTORY_KEY, handle)
}

export function forgetInstallDirectory(): Promise<void> {
  return deleteDirectoryHandle(INSTALL_DIRECTORY_KEY)
}

/**
 * Reads the chosen folder's root manifest and refuses anything that is not
 * this extension at the version being replaced (or already at the target).
 * Throws `folder-invalid` / `variant-mismatch`.
 */
export async function verifyInstallDirectory(
  directory: FileSystemDirectoryHandle,
  expectation: FolderManifestExpectation,
): Promise<void> {
  let text: string
  try {
    const handle = await directory.getFileHandle('manifest.json', { create: false })
    text = await (await handle.getFile()).text()
  } catch {
    throw new UpdateApplyError(
      'folder-invalid',
      'The selected folder has no readable manifest.json.',
    )
  }
  validateInstallFolderManifest(text, expectation)
}
