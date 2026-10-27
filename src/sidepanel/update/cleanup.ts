/**
 * Removes the updater's backup folders once the new build is actually running.
 *
 * Runs when the panel opens. Before the reload the panel still runs the old
 * version, and the backup is the only way back — so a backup is only touched
 * when the running version is at least the one it belongs to. File System
 * Access permissions may be `prompt` after a browser restart; deleting would
 * need a user gesture, so that case waits for the next open.
 *
 * @module sidepanel/update/cleanup
 */

import { BACKUP_FOLDER_PREFIX, removeBackupFolder } from '../../lib/update/apply'
import { peekInstallDirectory } from '../../lib/update/directory'
import { readUpdateBackups, removeUpdateBackup } from '../../lib/update/state'
import { isNewerVersion } from '../../lib/update/version'

function isBackupFolderName(folder: string): boolean {
  return (
    folder.startsWith(BACKUP_FOLDER_PREFIX) &&
    folder.length > BACKUP_FOLDER_PREFIX.length &&
    !folder.includes('/') &&
    !folder.includes('\\')
  )
}

function isMissingEntry(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError'
}

export async function cleanUpUpdateBackups(currentVersion: string): Promise<void> {
  const backups = await readUpdateBackups()
  // Keep everything newer than the running build: those files are on disk but
  // not loaded, so their backups still guard the working version.
  const ready = backups.filter((backup) => !isNewerVersion(backup.version, currentVersion))
  if (ready.length === 0) return

  const saved = await peekInstallDirectory()
  if (!saved || saved.permission !== 'granted') return

  for (const backup of ready) {
    // A marker that does not name one of our folders is dropped untouched.
    if (!isBackupFolderName(backup.folder)) {
      await removeUpdateBackup(backup.folder)
      continue
    }
    try {
      await removeBackupFolder(saved.handle, backup.folder)
      await removeUpdateBackup(backup.folder)
    } catch (error) {
      // Already gone (the user deleted it) is success; anything else retries
      // on the next panel open.
      if (isMissingEntry(error)) await removeUpdateBackup(backup.folder)
    }
  }
}
