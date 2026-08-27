/**
 * Editor logs view — shows recent workflow runs and their steps, fetched from
 * the background running/finished boards (same data the side panel's History
 * tab reads). Used when the toolbar "Logs" tab is active.
 *
 * @module workflow-editor/sidebar/EditorLogs
 */

import { useEffect, useState } from 'react'
import { sendCommand } from '../../lib/messages'
import type { TranslateFn } from '../i18n'

interface Step {
  kind: string
  text: string
  ts?: number
}
interface RunView {
  runId: string
  label: string
  source: string
  startedAt: number
  finishedAt?: number
  outcome?: 'ok' | 'failed' | 'cancelled'
  summary?: string
  steps: Step[]
}

interface Boards {
  runs: RunView[]
  finished: RunView[]
}

function time(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return ''
  }
}

export default function EditorLogs({ t }: { t: TranslateFn }) {
  const [boards, setBoards] = useState<Boards>({ runs: [], finished: [] })

  useEffect(() => {
    let live = true
    const load = async () => {
      try {
        const r = await sendCommand({ type: 'workflows.running' })
        if (live && r.type === 'workflows.running') {
          setBoards({ runs: r.runs as RunView[], finished: r.finished as RunView[] })
        }
      } catch {
        /* background may be waking up; leave the list empty */
      }
    }
    void load()
    const id = setInterval(load, 1500)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [])

  const all = [...boards.runs, ...boards.finished]

  return (
    <div className="wf-sidebar-scroll">
      <div className="wf-section-title">{t('logsTitle')}</div>
      {all.length === 0 && <p className="wf-form-note">{t('logsEmpty')}</p>}
      <div className="wf-logs">
        {all.map((run) => (
          <div key={run.runId} className={`wf-log-run wf-log-${run.outcome ?? 'running'}`}>
            <div className="wf-log-head">
              <span className="wf-log-label">{run.label || 'workflow'}</span>
              <span className="wf-log-meta">
                {run.outcome === undefined ? t('running') : time(run.finishedAt ?? run.startedAt)}
              </span>
            </div>
            {run.summary && <p className="wf-log-summary">{run.summary}</p>}
            {run.steps?.slice(-30).map((s, i) => (
              <div key={i} className={`wf-log-step wf-log-step-${s.kind}`}>
                <span className="wf-log-step-text">{s.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
