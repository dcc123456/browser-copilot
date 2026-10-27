/**
 * The updater's backups are removed when the panel opens on the new build,
 * and only then: before the reload they are the way back to a working version.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateBackup } from '../src/lib/update/types'

const mock = vi.hoisted(() => {
  const backups: UpdateBackup[] = []
  const removeEntry = vi.fn(async (_name: string, _options?: { recursive?: boolean }) => {})
  const peek = {
    value: null as null | {
      handle: FileSystemDirectoryHandle
      name: string
      permission: PermissionState
    },
  }
  return { backups, removeEntry, peek }
})

vi.mock('../src/lib/update/state', () => ({
  readUpdateBackups: async () => [...mock.backups],
  removeUpdateBackup: async (folder: string) => {
    const index = mock.backups.findIndex((item) => item.folder === folder)
    if (index >= 0) mock.backups.splice(index, 1)
  },
}))

vi.mock('../src/lib/update/directory', () => ({
  peekInstallDirectory: async () => mock.peek.value,
}))

const { cleanUpUpdateBackups } = await import('../src/sidepanel/update/cleanup')

const BACKUP = 'browser-copilot-backup-0.6.11-2026-10-26T05-10-03-000Z'
const handle = { removeEntry: mock.removeEntry } as unknown as FileSystemDirectoryHandle

beforeEach(() => {
  mock.backups.length = 0
  mock.removeEntry.mockReset()
  mock.removeEntry.mockResolvedValue(undefined)
  mock.peek.value = { handle, name: 'browser-copilot', permission: 'granted' }
})

describe('cleaning up update backups', () => {
  it('deletes the backup once the panel runs the updated version', async () => {
    mock.backups.push({ folder: BACKUP, version: '0.6.12' })

    await cleanUpUpdateBackups('0.6.12')

    expect(mock.removeEntry).toHaveBeenCalledWith(BACKUP, { recursive: true })
    expect(mock.backups).toEqual([])
  })

  it('keeps the backup while the old version is still running', async () => {
    mock.backups.push({ folder: BACKUP, version: '0.6.12' })

    await cleanUpUpdateBackups('0.6.11')

    expect(mock.removeEntry).not.toHaveBeenCalled()
    expect(mock.backups).toHaveLength(1)
  })

  it('waits for a user gesture when permission is not granted', async () => {
    mock.backups.push({ folder: BACKUP, version: '0.6.12' })
    mock.peek.value = { handle, name: 'browser-copilot', permission: 'prompt' }

    await cleanUpUpdateBackups('0.6.12')

    expect(mock.removeEntry).not.toHaveBeenCalled()
    expect(mock.backups).toHaveLength(1)
  })

  it('drops the marker when the folder is already gone', async () => {
    mock.backups.push({ folder: BACKUP, version: '0.6.12' })
    mock.removeEntry.mockRejectedValue(new DOMException('missing', 'NotFoundError'))

    await cleanUpUpdateBackups('0.6.12')

    expect(mock.backups).toEqual([])
  })

  it('retries on the next open after another failure', async () => {
    mock.backups.push({ folder: BACKUP, version: '0.6.12' })
    mock.removeEntry.mockRejectedValue(new DOMException('busy', 'NoModificationAllowedError'))

    await cleanUpUpdateBackups('0.6.12')

    expect(mock.backups).toHaveLength(1)
  })

  it('drops a marker that does not name one of our folders', async () => {
    mock.backups.push({ folder: '../somewhere-else', version: '0.6.12' })

    await cleanUpUpdateBackups('0.6.12')

    expect(mock.removeEntry).not.toHaveBeenCalled()
    expect(mock.backups).toEqual([])
  })
})
