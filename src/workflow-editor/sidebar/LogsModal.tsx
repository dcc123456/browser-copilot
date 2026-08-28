/**
 * Run logs modal — the Automa-style logs list for a workflow.
 *
 * Shows ONE ROW PER RUN, collapsed by default (Automa's logs table): a status
 * icon, the workflow name, outcome, start time, block count and duration.
 * Clicking a row opens the {@link RunDetailModal}, which drills into that run
 * as a console trace grouped by block. There is intentionally NO auto-scroll —
 * the list stays put while runs update in the background.
 *
 * @module workflow-editor/sidebar/LogsModal
 */

import { useEffect, useMemo, useState } from 'react'
import { sendCommand } from '../../lib/messages'
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

function RunRow({ run, onOpen }: { run: RunView; onOpen: (run: RunView) => void }) {
  const state = run.outcome
  const icon =
    state === undefined
      ? 'ri-loader-4-line wf-spin'
      : state === 'ok'
        ? 'ri-checkbox-circle-fill'
        : state === 'failed'
          ? 'ri-close-circle-fill'
          : 'ri-stop-circle-fill'
  const iconCls =
    state === undefined
      ? 'wf-run-running'
      : state === 'ok'
        ? 'wf-ok'
        : state === 'failed'
          ? 'wf-err'
          : 'wf-warn'
  return (
    <button type="button" className="wf-run-row" onClick={() => onOpen(run)}>
      <i className={`wf-run-icon ${icon} ${iconCls}`} />
      <span className="wf-run-name" title={run.label}>
        {run.label || 'workflow'}
      </span>
      <span className={`wf-run-badge wf-run-badge-${state ?? 'running'}`}>
        {state === undefined ? 'running' : state}
      </span>
      <span className="wf-run-meta">{blockCount(run)} blocks</span>
      <span className="wf-run-meta">{runDuration(run) || '…'}</span>
      <span className="wf-run-meta">{clock(run.startedAt)}</span>
      <i className="ri-chevron-right-line wf-run-chevron" />
    </button>
  )
}

export default function LogsModal({
  open,
  onClose,
  workflowId,
  debugMode,
  t,
}: {
  open: boolean
  onClose: () => void
  workflowId: string | null
  debugMode: boolean
  t: TranslateFn
}) {
  const [boards, setBoards] = useState<{ runs: RunView[]; finished: RunView[] }>({ runs: [], finished: [] })
  const [openRunId, setOpenRunId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    const load = async () => {
      try {
        const r = await sendCommand({ type: 'workflows.running', workflowId: workflowId ?? undefined })
        if (live && r.type === 'workflows.running') {
          setBoards({ runs: r.runs as RunView[], finished: r.finished as RunView[] })
        }
      } catch {
        /* background may be waking */
      }
    }
    void load()
    const id = setInterval(load, 1200)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [open, workflowId])

  // Newest first: running on top, then finished (already newest-first).
  const all = useMemo(() => [...boards.runs, ...boards.finished], [boards])
  // Keep the open run's live data fresh by deriving it from the latest board.
  const openRun = openRunId ? all.find((r) => r.runId === openRunId) ?? null : null

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        icon="ri-terminal-box-line"
        title={t('logsTitle')}
        size="md"
        actions={
          debugMode ? (
            <span className="wf-logs-debug-badge">
              <i className="ri-bug-line" /> Debug
            </span>
          ) : undefined
        }
      >
        <div className="wf-runs-list">
          {all.length === 0 && <p className="wf-form-note">{t('logsEmpty')}</p>}
          {all.map((run) => (
            <RunRow key={run.runId} run={run} onOpen={(r) => setOpenRunId(r.runId)} />
          ))}
          {!debugMode && all.length > 0 && (
            <p className="wf-logs-debug-hint">
              <i className="ri-bug-line" /> {t('debugHint')}
            </p>
          )}
        </div>
      </Modal>

      <RunDetailModal
        run={openRun}
        debug={debugMode}
        onClose={() => setOpenRunId(null)}
        t={t}
      />
    </>
  )
}
