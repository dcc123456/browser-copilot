/**
 * Editor logs view — shows detailed run logs for the CURRENT workflow only.
 *
 * Polls the background running/finished boards filtered by workflowId and
 * renders every engine step (block marker + status/result/error line) with a
 * per-step timestamp, plus the full failure text for failed runs.
 *
 * @module workflow-editor/sidebar/EditorLogs
 */

import { useEffect, useState } from 'react'
import { sendCommand } from '../../lib/messages'
import type { TranslateFn } from '../i18n'

interface Step {
  at: number
  kind: 'tool' | 'status' | 'result' | 'error' | 'info'
  text: string
}
interface RunView {
  runId: string
  label: string
  source: string
  startedAt: number
  finishedAt?: number
  outcome?: 'ok' | 'failed' | 'cancelled' | 'skipped'
  summary?: string
  error?: string
  steps: Step[]
}

interface Boards {
  runs: RunView[]
  finished: RunView[]
}

function clock(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString('en-GB', { hour12: false })
  } catch {
    return ''
  }
}

function Run({ run }: { run: RunView }) {
  const state = run.outcome
  return (
    <div className={`wf-log-run wf-log-${state ?? 'running'}`}>
      <div className="wf-log-head">
        <span className="wf-log-label">{run.outcome === undefined ? '● ' : ''}{run.label || 'workflow'}</span>
        <span className="wf-log-meta">
          {run.outcome === undefined ? 'running' : state} · {clock(run.finishedAt ?? run.startedAt)}
        </span>
      </div>

      <div className="wf-log-steps">
        {run.steps?.map((s, i) => (
          <div key={i} className={`wf-log-line wf-log-line-${s.kind}`}>
            <span className="wf-log-time">{clock(s.at)}</span>
            {s.kind === 'tool' ? (
              <span className="wf-log-block">▸ {s.text}</span>
            ) : (
              <span className="wf-log-text">{s.text}</span>
            )}
          </div>
        ))}
      </div>

      {run.outcome === 'failed' && run.error && (
        <pre className="wf-log-error">{run.error}</pre>
      )}
      {run.outcome === 'cancelled' && <p className="wf-log-cancel">Cancelled</p>}
    </div>
  )
}

export default function EditorLogs({ workflowId, t }: { workflowId: string | null; t: TranslateFn }) {
  const [boards, setBoards] = useState<Boards>({ runs: [], finished: [] })

  useEffect(() => {
    let live = true
    const load = async () => {
      try {
        const r = await sendCommand({ type: 'workflows.running', workflowId: workflowId ?? undefined })
        if (live && r.type === 'workflows.running') {
          setBoards({ runs: r.runs as RunView[], finished: r.finished as RunView[] })
        }
      } catch {
        /* background may be waking; leave list unchanged */
      }
    }
    void load()
    const id = setInterval(load, 1200)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [workflowId])

  // Running first (newest), then finished (already newest first).
  const all = [...boards.runs, ...boards.finished]

  return (
    <div className="wf-sidebar-scroll">
      <div className="wf-section-title">{t('logsTitle')}</div>
      {all.length === 0 && <p className="wf-form-note">{t('logsEmpty')}</p>}
      <div className="wf-logs">
        {all.map((run) => (
          <Run key={run.runId} run={run} />
        ))}
      </div>
    </div>
  )
}
