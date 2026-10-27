/**
 * The in-place update flow: reuse (or pick once) the unpacked install folder,
 * download the release, verify it, write it, and offer the reload.
 *
 * The dialog freezes the release and asset it opened with. A background check
 * completing mid-flow must never swap the package under an in-progress write.
 *
 * @module sidepanel/update/UpdateDialog
 */

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Clock, Download, ExternalLink, FolderOpen, RefreshCw, RotateCw, X } from 'lucide-react'
import type { Messages } from '../../lib/i18n'
import { applyUpdate } from '../../lib/update/apply'
import {
  peekInstallDirectory,
  pickInstallDirectory,
  rememberInstallDirectory,
  resolveInstallDirectory,
  verifyInstallDirectory,
  type SavedInstallDirectory,
} from '../../lib/update/directory'
import { addUpdateBackup, markPendingReload } from '../../lib/update/state'
import {
  UpdateApplyError,
  type UpdateAssetInfo,
  type UpdateProgress,
  type UpdateReleaseInfo,
} from '../../lib/update/types'
import FormDialog from '../../ui/FormDialog'
import { useT } from '../i18n'
import { describeApplyError } from './error-text'
import IconButton from './IconButton'
import { openReleasePage } from './open-release'
import type { UpdateSnapshot } from './use-update-snapshot'

type Phase = 'idle' | 'working' | 'done' | 'error'

export default function UpdateDialog({
  snapshot,
  onClose,
}: {
  snapshot: UpdateSnapshot
  onClose: () => void
}): ReactElement {
  const t = useT()
  const [target] = useState<UpdateReleaseInfo | null>(() =>
    snapshot.availableVersion ? (snapshot.state?.latest ?? null) : null,
  )
  const [asset] = useState<UpdateAssetInfo | null>(() =>
    snapshot.availableVersion ? (snapshot.state?.asset ?? null) : null,
  )
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saved, setSaved] = useState<SavedInstallDirectory | null>(null)
  const [doneVersion, setDoneVersion] = useState<string | null>(null)
  const [backupFolder, setBackupFolder] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let alive = true
    void peekInstallDirectory().then((info) => {
      if (alive) setSaved(info)
    })
    return () => {
      alive = false
      abortRef.current?.abort()
    }
  }, [])

  if (!target) {
    return (
      <FormDialog
        footer={<IconButton icon={X} label={t.updateClose} onClick={onClose} />}
        onClose={onClose}
        title={t.updateDialogTitle}
      >
        <p className="m-0 text-[12.5px] text-muted">{t.updateUpToDate}</p>
      </FormDialog>
    )
  }

  // The install-type probe is async; do not flash "manual update" before it
  // answers.
  if (snapshot.installType === null) {
    return (
      <FormDialog
        footer={<IconButton icon={X} label={t.updateClose} onClick={onClose} />}
        onClose={onClose}
        title={t.updateDialogTitle}
      >
        <p className="m-0 text-[12.5px] text-muted">{t.loading}</p>
      </FormDialog>
    )
  }

  const requestClose = (): void => {
    if (phase !== 'working') onClose()
  }

  const folderExpectation = {
    expectedName: snapshot.manifestName,
    currentVersion: snapshot.currentVersion,
    targetVersion: target.version,
    expectNoOcr: snapshot.variant === 'no-ocr',
  }

  const acceptPickedFolder = async (): Promise<FileSystemDirectoryHandle | null> => {
    const picked = await pickInstallDirectory()
    if (!picked) return null
    await verifyInstallDirectory(picked, folderExpectation)
    await rememberInstallDirectory(picked)
    setSaved({ handle: picked, name: picked.name, permission: 'granted' })
    return picked
  }

  const changeFolder = async (): Promise<void> => {
    setNotice(null)
    try {
      await acceptPickedFolder()
    } catch (error) {
      setNotice(describeApplyError(t, error))
    }
  }

  /**
   * The browser has no API for "the folder this extension was loaded from", so
   * the first update must ask once. The handle is remembered afterwards; later
   * updates use it directly and only reassign permission inside the click.
   */
  const readyDirectory = async (): Promise<FileSystemDirectoryHandle | null> => {
    if (saved) {
      if (saved.permission === 'granted') return saved.handle
      const resolved = await resolveInstallDirectory()
      if (resolved) {
        setSaved({ handle: resolved, name: resolved.name, permission: 'granted' })
        return resolved
      }
    }
    return acceptPickedFolder()
  }

  const start = async (): Promise<void> => {
    if (!asset) return
    setNotice(null)
    let directory: FileSystemDirectoryHandle | null
    try {
      directory = await readyDirectory()
    } catch (error) {
      setNotice(describeApplyError(t, error))
      setPhase('error')
      return
    }
    if (!directory) return

    setPhase('working')
    setProgress({ stage: 'downloading', loaded: 0, total: asset.size })
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const result = await applyUpdate({
        directory,
        asset,
        currentVersion: snapshot.currentVersion,
        targetVersion: target.version,
        expectedName: snapshot.manifestName,
        variant: snapshot.variant,
        signal: controller.signal,
        onProgress: setProgress,
      })
      await markPendingReload(target.version)
      await addUpdateBackup({ folder: result.backupFolder, version: target.version })
      setDoneVersion(target.version)
      setBackupFolder(result.backupFolder)
      setPhase('done')
    } catch (error) {
      if (error instanceof UpdateApplyError && error.code === 'aborted') {
        setPhase('idle')
        setProgress(null)
        setNotice(null)
      } else {
        setNotice(describeApplyError(t, error))
        setPhase('error')
      }
    } finally {
      abortRef.current = null
    }
  }

  const versionLines = (
    <>
      <p className="m-0 text-[12.5px] text-muted">
        {t.updateCurrentVersion({ version: snapshot.currentVersion })}
      </p>
      <p className="m-0 text-[12.5px] font-medium text-ink">
        {t.updateTargetVersion({ version: target.version })}
      </p>
    </>
  )

  const notes = (
    <div>
      <p className="m-0 mb-1 text-[12px] font-medium text-ink">{t.updateReleaseNotes}</p>
      <div className="max-h-36 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-panel-2 p-2.5 text-[12px] leading-relaxed text-muted">
        {target.notes.trim() || t.updateNotesUnavailable}
      </div>
    </div>
  )

  const noticeBox = notice && (
    <p
      className="m-0 rounded-lg border border-err bg-err-surface p-2.5 text-[12px] leading-relaxed break-words text-err"
      role="alert"
    >
      {notice}
    </p>
  )

  if (!snapshot.canApply) {
    return (
      <FormDialog
        footer={
          <>
            <IconButton icon={X} label={t.updateClose} onClick={onClose} />
            <IconButton
              icon={ExternalLink}
              label={t.updateOpenRelease}
              onClick={() => openReleasePage(target.htmlUrl)}
              tone="primary"
            />
          </>
        }
        onClose={onClose}
        title={t.updateDialogTitle}
        width="lg"
      >
        <div className="space-y-3">
          {versionLines}
          <p className="m-0 rounded-lg border border-warn bg-warn-surface p-2.5 text-[12px] leading-relaxed text-warn">
            {t.updateManualHint}
          </p>
          {notes}
        </div>
      </FormDialog>
    )
  }

  const folderRow = (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-panel-2 p-2.5">
      <div className="min-w-0">
        <p className="m-0 text-[12px] font-medium text-ink">{t.updateInstallFolder}</p>
        <p className="m-0 mt-0.5 text-[11.5px] leading-relaxed text-muted">
          {saved ? t.updateFolderSaved({ name: saved.name }) : t.updateFolderFirstTime}
        </p>
      </div>
      {saved && (
        <IconButton
          disabled={phase === 'working'}
          icon={FolderOpen}
          label={t.updateChangeFolder}
          onClick={() => void changeFolder()}
          size="sm"
        />
      )}
    </div>
  )

  let footer: ReactNode
  if (phase === 'working') {
    footer = (
      <IconButton icon={X} label={t.updateCancel} onClick={() => abortRef.current?.abort()} />
    )
  } else if (phase === 'done') {
    footer = (
      <>
        <IconButton icon={Clock} label={t.updateReloadLater} onClick={onClose} />
        <IconButton
          icon={RotateCw}
          label={t.updateReloadNow}
          onClick={snapshot.reloadNow}
          tone="primary"
        />
      </>
    )
  } else if (phase === 'error') {
    footer = (
      <>
        <IconButton icon={X} label={t.updateClose} onClick={onClose} />
        <IconButton
          icon={RefreshCw}
          label={t.updateTryAgain}
          onClick={() => void start()}
          tone="primary"
        />
      </>
    )
  } else {
    footer = (
      <>
        <IconButton icon={X} label={t.updateCancel} onClick={onClose} />
        <IconButton
          disabled={!asset}
          icon={Download}
          label={t.updateStart}
          onClick={() => void start()}
          tone="primary"
        />
      </>
    )
  }

  let body: ReactNode
  if (phase === 'working') {
    const percent = progressPercent(progress)
    body = (
      <div className="space-y-2">
        {versionLines}
        <p className="m-0 text-[12.5px] text-ink">{progressLabel(t, progress)}</p>
        <div
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent ?? undefined}
          className="h-1.5 w-full overflow-hidden rounded-full bg-panel-2"
          role="progressbar"
        >
          <div
            className={
              percent === null
                ? 'h-full w-full animate-pulse rounded-full bg-accent/60'
                : 'h-full rounded-full bg-accent transition-[width] duration-200'
            }
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
        <p className="m-0 text-[11px] leading-relaxed text-muted">{t.updateOverwriteWarning}</p>
      </div>
    )
  } else if (phase === 'done') {
    body = (
      <div className="space-y-1.5">
        <p className="m-0 text-[13px] font-semibold text-ok">{t.updateDoneTitle}</p>
        <p className="m-0 text-[12.5px] leading-relaxed text-muted">
          {t.updateDoneBody({ version: doneVersion ?? target.version })}
        </p>
        {backupFolder && (
          <p className="m-0 text-[11.5px] leading-relaxed break-words text-muted">
            {t.updateBackupNote({ folder: backupFolder })}
          </p>
        )}
      </div>
    )
  } else {
    body = (
      <div className="space-y-3">
        {versionLines}
        {phase === 'error' ? (
          <div className="space-y-1.5">
            <p className="m-0 text-[12px] font-medium text-err">{t.updateErrorTitle}</p>
            {noticeBox}
          </div>
        ) : (
          <p className="m-0 rounded-lg border border-warn bg-warn-surface p-2.5 text-[12px] leading-relaxed text-warn">
            {t.updateOverwriteWarning}
          </p>
        )}
        {notes}
        {folderRow}
        {phase !== 'error' && noticeBox}
      </div>
    )
  }

  return (
    <FormDialog footer={footer} onClose={requestClose} title={t.updateDialogTitle} width="lg">
      {body}
    </FormDialog>
  )
}

function progressPercent(progress: UpdateProgress | null): number | null {
  if (!progress) return null
  if (progress.stage === 'downloading') {
    if (!progress.total || progress.total <= 0) return null
    return Math.min(100, Math.round((progress.loaded / progress.total) * 100))
  }
  if (progress.stage === 'writing') {
    if (!progress.filesTotal) return null
    return Math.min(100, Math.round(((progress.filesWritten ?? 0) / progress.filesTotal) * 100))
  }
  return null
}

function progressLabel(t: Messages, progress: UpdateProgress | null): string {
  if (!progress) return t.updateProgressExtracting
  switch (progress.stage) {
    case 'downloading':
      return t.updateProgressDownloading({ percent: progressPercent(progress) ?? 0 })
    case 'verifying':
      return t.updateProgressVerifying
    case 'extracting':
      return t.updateProgressExtracting
    case 'backing-up':
      return t.updateProgressBackingUp
    case 'writing':
      return t.updateProgressWriting({
        done: progress.filesWritten ?? 0,
        total: progress.filesTotal ?? 0,
      })
    case 'done':
      return t.updateProgressDone
  }
}
