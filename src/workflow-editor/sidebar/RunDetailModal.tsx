/**
 * Run-detail modal — opened when a row in the logs list is clicked.
 *
 * Automa's LogsHistory: a DARK console (`bg-gray-900`, mono) with an error
 * banner at the top, a search box + export action in the header, and a flat
 * timeline of executed blocks. A block row with captured variables opens the
 * variable inspector (GUI / Raw tabs). This is a modal stacked on top of the
 * logs list.
 *
 * @module workflow-editor/sidebar/RunDetailModal
 */

import { useMemo, useState } from 'react'
import Modal from '../ui/Modal'
import {
  TraceRow,
  VariablesInspector,
  buildTrace,
  clock,
  type RunView,
} from './log-view'
import type { TranslateFn } from '../i18n'

export default function RunDetailModal({
  run,
  debug,
  onClose,
  t,
}: {
  run: RunView | null
  debug: boolean
  onClose: () => void
  t: TranslateFn
}) {
  const [inspectVars, setInspectVars] = useState<Record<string, unknown> | null>(null)
  const [query, setQuery] = useState('')

  const trace = useMemo(() => (run ? buildTrace(run) : []), [run])
  const state = run?.outcome

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    if (!q) return trace
    return trace.filter(
      (e) =>
        e.label.toLocaleLowerCase().includes(q) ||
        e.description.toLocaleLowerCase().includes(q) ||
        e.lines.some((l) => l.text.toLocaleLowerCase().includes(q)),
    )
  }, [trace, query])

  // First errored block drives the "On the X block" banner (Automa errorBlock).
  const errorEntry = trace.find((e) => e.type === 'error')

  const exportLogs = () => {
    if (!run) return
    const payload = {
      runId: run.runId,
      label: run.label,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      outcome: run.outcome,
      error: run.error,
      entries: trace.map((e) => ({
        at: new Date(e.at).toISOString(),
        block: e.label,
        durationMs: e.durationMs,
        type: e.type,
        lines: e.lines,
        variables: e.vars,
      })),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `log-${run.label || 'workflow'}-${run.runId}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const title = (
    <span className="wf-run-detail-title">
      {state === undefined && <i className="ri-loader-4-line wf-spin" />}
      {state === 'ok' && <i className="ri-checkbox-circle-fill wf-ok" />}
      {state === 'failed' && <i className="ri-close-circle-fill wf-err" />}
      {state === 'cancelled' && <i className="ri-stop-circle-fill wf-warn" />}
      <span>{run?.label || 'workflow'}</span>
    </span>
  )

  return (
    <Modal open={!!run} onClose={onClose} icon="ri-list-check-2" title={title} size="lg">
      {run && (
        <div className="wf-console">
          {/* Tool row: search + export (Automa LogsHistory header) */}
          <div className="wf-console-tools">
            <span className="wf-console-when">
              {state === undefined ? t('running') : state} · {clock(run.finishedAt ?? run.startedAt)}
            </span>
            <span className="wf-console-tools-spacer" />
            <button type="button" className="wf-console-export" onClick={exportLogs}>
              <i className="ri-download-2-line" /> {t('exportLogs')}
            </button>
            <div className="wf-console-search">
              <i className="ri-search-2-line" />
              <input
                value={query}
                placeholder={t('search')}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>

          {inspectVars ? (
            <VariablesInspector vars={inspectVars} onBack={() => setInspectVars(null)} />
          ) : (
            <div className="wf-console-body">
              {state === 'failed' && (errorEntry || run.error) && (
                <div className="wf-console-banner">
                  <p>{run.error?.split('\n')[0] || errorEntry?.lines.find((l) => l.kind === 'error')?.text}</p>
                  {errorEntry && (
                    <p className="wf-console-banner-block">
                      {t('onTheBlock').replace('{name}', errorEntry.label)}
                    </p>
                  )}
                </div>
              )}
              {state === 'cancelled' && <div className="wf-console-banner wf-console-banner-stop">Cancelled</div>}
              {filtered.length === 0 && <p className="wf-console-empty">{t('logsEmpty')}</p>}
              <div className="wf-console-trace">
                {filtered.map((e, i) => (
                  <TraceRow key={i} entry={e} debug={debug} onInspect={setInspectVars} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
