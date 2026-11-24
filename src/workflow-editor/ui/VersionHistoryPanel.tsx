import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { sendCommand } from '../../lib/messages'
import type { Workflow } from '../../lib/workflow/types'
import {
  workflowFingerprint,
  rollbackSourceDeleted,
  type WorkflowVersionEntry,
  type WorkflowVersionIndex,
} from '../../lib/workflow/workflow-versions'
import type { TranslateFn } from '../i18n'

interface VersionHistoryPanelProps {
  open: boolean
  workflowId: string
  /** The canvas as it stands, so the list can mark which version is current. */
  current: Workflow
  onClose: () => void
  /** Puts an old version on the canvas; the caller records the rollback. */
  onApply: (snapshot: Workflow, fromVersion: number) => Promise<void>
  toast: (text: string, tone: 'ok' | 'info' | 'error') => void
  t: TranslateFn
}

/** The save history of one workflow: browse, apply, delete. */
export default function VersionHistoryPanel({
  open,
  workflowId,
  current,
  onClose,
  onApply,
  toast,
  t,
}: VersionHistoryPanelProps) {
  const [index, setIndex] = useState<WorkflowVersionIndex | null>(null)
  const [busyVersion, setBusyVersion] = useState<number | null>(null)

  const load = useCallback(async () => {
    const result = await sendCommand({ type: 'workflows.versions.list', workflowId })
    if (result.type === 'workflows.versions.list') setIndex(result.index)
  }, [workflowId])

  useEffect(() => {
    if (!open) return
    setIndex(null)
    void load()
  }, [open, load])

  if (!open) return null

  const fingerprint = workflowFingerprint(current)
  const entries = [...(index?.entries ?? [])].reverse()

  const apply = async (entry: WorkflowVersionEntry) => {
    setBusyVersion(entry.version)
    try {
      const result = await sendCommand({
        type: 'workflows.versions.read',
        workflowId,
        version: entry.version,
      })
      if (result.type !== 'workflows.versions.read' || !result.workflow) {
        toast(t('versionsMissing'), 'error')
        return
      }
      await onApply(result.workflow, entry.version)
      toast(`${t('versionsApplied')} v${entry.version}`, 'ok')
      await load()
    } finally {
      setBusyVersion(null)
    }
  }

  const remove = async (entry: WorkflowVersionEntry) => {
    setBusyVersion(entry.version)
    try {
      const result = await sendCommand({
        type: 'workflows.versions.delete',
        workflowId,
        version: entry.version,
        currentFingerprint: fingerprint,
      })
      if (result.type !== 'workflows.versions.delete') return
      if (!result.ok) {
        toast(t('versionsCurrentImmutable'), 'error')
        return
      }
      if (result.index) setIndex(result.index)
      toast(t('versionsDeleted'), 'info')
    } finally {
      setBusyVersion(null)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" role="dialog" aria-modal>
      <div className="flex h-full w-full max-w-md flex-col border-l border-border bg-panel shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{t('versionsTitle')}</h2>
          <button
            className="rounded p-1 text-muted hover:text-ink"
            onClick={onClose}
            title={t('close')}
            type="button"
          >
            <X size={15} />
          </button>
        </header>
        <p className="px-4 pt-3 text-[11px] leading-relaxed text-muted">{t('versionsHint')}</p>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {index === null ? (
            <p className="px-1 text-xs text-muted">{t('versionsLoading')}</p>
          ) : entries.length === 0 ? (
            <p className="px-1 text-xs text-muted">{t('versionsEmpty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {entries.map((entry) => {
                const isCurrent = entry.fingerprint === fingerprint
                const sourceGone = index ? rollbackSourceDeleted(index, entry) : false
                return (
                  <li
                    key={entry.version}
                    className={`rounded-lg border p-3 text-xs ${
                      isCurrent ? 'border-accent bg-accent-soft/30' : 'border-border bg-panel-2'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink">
                        {t('versionNumber')}
                        {entry.version} · {t('versionRevision')}
                        {entry.revision}
                      </span>
                      <span className="text-muted">{new Date(entry.at).toLocaleString()}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
                      <span>{`${entry.nodes} ${t('versionsNodes')} · ${entry.edges} ${t('versionsEdges')}`}</span>
                      <span>{formatBytes(entry.bytes)}</span>
                      {isCurrent && <span className="text-accent">{t('versionCurrent')}</span>}
                      {entry.note && <span className="text-warn">{entry.note}</span>}
                      {entry.source === 'rollback' && sourceGone && (
                        <span className="text-err">{t('versionsSourceDeleted')}</span>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      {/* A rollback line is a trace, not an applicable version: it
                          has no snapshot of its own (see the design's choice (a)). */}
                      {entry.source === 'rollback' ? (
                        <span className="text-[11px] text-muted">{t('versionsTraceOnly')}</span>
                      ) : (
                        <button
                          className="rounded border border-border px-2 py-1 text-ink disabled:opacity-50"
                          disabled={busyVersion === entry.version}
                          onClick={() => void apply(entry)}
                          type="button"
                        >
                          {t('versionsApply')}
                        </button>
                      )}
                      <button
                        className="rounded border border-border px-2 py-1 text-muted disabled:opacity-50"
                        disabled={busyVersion === entry.version || isCurrent}
                        onClick={() => void remove(entry)}
                        title={isCurrent ? t('versionsCurrentImmutable') : t('versionsDelete')}
                        type="button"
                      >
                        {t('versionsDelete')}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
