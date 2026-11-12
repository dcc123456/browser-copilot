/**
 * Run logs modal — the Automa-style logs list for a workflow.
 *
 * Shows ONE ROW PER RUN, collapsed by default (Automa's logs table): a status
 * icon, the workflow name, outcome, start time, block count and duration.
 * Clicking a row opens the {@link RunDetailModal}, which drills into that run
 * as a console trace grouped by block. There is intentionally NO auto-scroll —
 * the list stays put while runs update in the background.
 *
 * Only finished runs can be deleted. A running run is still being appended to
 * and `finishRun()` would write it straight back to the finished board, so its
 * checkbox and delete control stay disabled until the run ends. Deletion goes
 * through `tasks.finished.delete`, which drops both the in-memory board entry
 * and the persisted record in one command.
 *
 * @module workflow-editor/sidebar/LogsModal
 */

import {
  Bug,
  ChevronRight,
  CircleCheck,
  CircleStop,
  CircleX,
  LoaderCircle,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sendCommand } from '../../lib/messages'
import { confirmDialog } from '../../ui/confirm'
import { toast } from '../../ui/toast'
import Modal from '../ui/Modal'
import RunDetailModal from './RunDetailModal'
import { clock, type RunView } from './log-view'
import type { TranslateFn } from '../i18n'

function runDuration(run: RunView): string {
  if (!run.finishedAt) return ''
  const ms = run.finishedAt - run.startedAt
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function blockCount(run: RunView): number {
  return run.steps?.filter((s) => s.kind === 'tool').length ?? 0
}

function RunRow({
  run,
  selected,
  busy,
  onToggle,
  onOpen,
  onDelete,
  t,
}: {
  run: RunView
  selected: boolean
  busy: boolean
  onToggle: (runId: string) => void
  onOpen: (run: RunView) => void
  onDelete: (run: RunView) => void
  t: TranslateFn
}) {
  const state = run.outcome
  const Icon =
    state === undefined
      ? LoaderCircle
      : state === 'ok'
        ? CircleCheck
        : state === 'failed'
          ? CircleX
          : CircleStop
  const iconCls =
    state === undefined
      ? 'wf-run-running'
      : state === 'ok'
        ? 'wf-ok'
        : state === 'failed'
          ? 'wf-err'
          : 'wf-warn'
  // Running rows must stay read-only: see the module note above.
  const deletable = state !== undefined
  return (
    <div className={`wf-run-row${selected ? ' wf-run-row-selected' : ''}`}>
      <input
        type="checkbox"
        className="wf-run-check"
        checked={selected}
        disabled={!deletable || busy}
        onChange={() => onToggle(run.runId)}
        aria-label={t('logsSelectOne')}
        title={deletable ? t('logsSelectOne') : undefined}
      />
      <button type="button" className="wf-run-open" onClick={() => onOpen(run)}>
        <Icon
          size={14}
          className={`wf-run-icon ${iconCls}${state === undefined ? ' wf-spin' : ''}`}
        />
        <span className="wf-run-name" title={run.label}>
          {run.label || 'workflow'}
        </span>
        <span className={`wf-run-badge wf-run-badge-${state ?? 'running'}`}>
          {state === undefined ? 'running' : state}
        </span>
        <span className="wf-run-meta">{blockCount(run)} blocks</span>
        <span className="wf-run-meta">{runDuration(run) || '…'}</span>
        <span className="wf-run-meta">{clock(run.startedAt)}</span>
        <ChevronRight size={12} className="wf-run-chevron" />
      </button>
      <button
        type="button"
        className="wf-run-delete"
        disabled={!deletable || busy}
        onClick={() => onDelete(run)}
        aria-label={t('logsDeleteOne')}
        title={t('logsDeleteOne')}
      >
        <Trash2 size={13} aria-hidden="true" />
      </button>
    </div>
  )
}

export default function LogsModal({
  open,
  onClose,
  workflowId,
  debugMode,
  onLocateNode,
  t,
}: {
  open: boolean
  onClose: () => void
  workflowId: string | null
  debugMode: boolean
  /** Center the canvas on a log row's node (editor only). */
  onLocateNode?: (nodeId: string) => void
  t: TranslateFn
}) {
  const [boards, setBoards] = useState<{ runs: RunView[]; finished: RunView[] }>({
    runs: [],
    finished: [],
  })
  const [openRunId, setOpenRunId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  // Guards both the 1200 ms poll and the reload issued right after a delete.
  // Only the newest in-flight load may write the board, so a response that was
  // already in flight before the delete cannot resurrect a removed row.
  const liveRef = useRef(false)
  const loadSeqRef = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeqRef.current
    try {
      const r = await sendCommand({
        type: 'workflows.running',
        workflowId: workflowId ?? undefined,
      })
      if (!liveRef.current || seq !== loadSeqRef.current) return
      if (r.type === 'workflows.running') {
        setBoards({ runs: r.runs as RunView[], finished: r.finished as RunView[] })
      }
    } catch {
      /* background may be waking */
    }
  }, [workflowId])

  useEffect(() => {
    if (!open) return
    liveRef.current = true
    void load()
    const id = setInterval(() => void load(), 1200)
    return () => {
      liveRef.current = false
      clearInterval(id)
    }
  }, [open, load])

  // Closing the logs panel must forget the drilled-in run: otherwise reopening
  // the panel puts the previous run's detail (and its variable inspector) back
  // on top of the list the user expected to see. The selection goes with it.
  useEffect(() => {
    if (open) return
    setOpenRunId(null)
    setSelected(new Set())
  }, [open])

  // Newest first: running on top, then finished (already newest-first).
  const all = useMemo(() => [...boards.runs, ...boards.finished], [boards])
  // Keep the open run's live data fresh by deriving it from the latest board.
  const openRun = openRunId ? (all.find((r) => r.runId === openRunId) ?? null) : null

  const deletableIds = useMemo(() => boards.finished.map((run) => run.runId), [boards.finished])

  // Runs can age out of the retained window while the panel is open. Prune
  // stale ids so the batch count and the "select all" state stay truthful.
  useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current
      const available = new Set(deletableIds)
      const next = new Set([...current].filter((id) => available.has(id)))
      return next.size === current.size ? current : next
    })
  }, [deletableIds])

  const toggleOne = (runId: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
  }

  const toggleAll = (): void => {
    setSelected((current) =>
      current.size === deletableIds.length ? new Set<string>() : new Set(deletableIds),
    )
  }

  const removeRuns = async (ids: string[]): Promise<void> => {
    if (ids.length === 0 || deleting) return
    const confirmed = await confirmDialog({
      title: t('logsDeleteTitle'),
      message: t('logsDeleteConfirm').replace('{count}', String(ids.length)),
      confirmText: t('delete'),
      cancelText: t('cancel'),
      danger: true,
    })
    if (confirmed !== true) return
    setDeleting(true)
    let removed = 0
    try {
      for (const runId of ids) {
        try {
          await sendCommand({ type: 'tasks.finished.delete', runId })
          removed += 1
          setSelected((current) => {
            if (!current.has(runId)) return current
            const next = new Set(current)
            next.delete(runId)
            return next
          })
        } catch {
          // Leave failures selected so the user can retry them.
        }
      }
      await load()
      if (removed > 0) {
        toast(t('logsDeleted').replace('{count}', String(removed)), 'ok')
        setOpenRunId((current) => (current && ids.includes(current) ? null : current))
      }
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        icon="lucide:SquareTerminal"
        title={t('logsTitle')}
        size="xl"
        actions={
          debugMode ? (
            <span className="wf-logs-debug-badge">
              <Bug size={14} /> Debug
            </span>
          ) : undefined
        }
      >
        {deletableIds.length > 0 && (
          <div className="wf-logs-batchbar">
            <label className="wf-logs-selectall">
              <input
                type="checkbox"
                checked={selected.size > 0 && selected.size === deletableIds.length}
                ref={(el) => {
                  if (el)
                    el.indeterminate = selected.size > 0 && selected.size < deletableIds.length
                }}
                disabled={deleting}
                onChange={toggleAll}
              />
              <span>{t('logsSelectAll')}</span>
            </label>
            <span className="wf-logs-batchcount">
              {selected.size} / {deletableIds.length}
            </span>
            <button
              type="button"
              className="wf-logs-delete-selected"
              disabled={selected.size === 0 || deleting}
              onClick={() => void removeRuns([...selected])}
            >
              {t('logsDeleteSelected').replace('{count}', String(selected.size))}
            </button>
          </div>
        )}
        <div className="wf-runs-list min-h-[50vh]">
          {all.length === 0 && <p className="wf-form-note">{t('logsEmpty')}</p>}
          {all.map((run) => (
            <RunRow
              key={run.runId}
              run={run}
              selected={selected.has(run.runId)}
              busy={deleting}
              onToggle={toggleOne}
              onOpen={(r) => setOpenRunId(r.runId)}
              onDelete={(r) => void removeRuns([r.runId])}
              t={t}
            />
          ))}
          {!debugMode && all.length > 0 && (
            <p className="wf-logs-debug-hint">
              <Bug size={14} /> {t('debugHint')}
            </p>
          )}
        </div>
      </Modal>

      <RunDetailModal
        run={openRun}
        debug={debugMode}
        onClose={() => setOpenRunId(null)}
        // Locate means looking at the canvas, so both stacked modals have to
        // uncover it first.
        onLocateNode={
          onLocateNode
            ? (nodeId) => {
                setOpenRunId(null)
                onLocateNode(nodeId)
              }
            : undefined
        }
        t={t}
      />
    </>
  )
}
