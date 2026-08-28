/**
 * Shared run-log view pieces — types, step→block grouping, and the Automa-style
 * console trace.
 *
 * Automa's LogsHistory renders a run as a DARK console timeline
 * (`bg-gray-900`, `font-mono text-sm`): one row per executed block with a
 * `HH:mm:ss (duration)` column, a coloured type icon, and the block name +
 * description. Clicking a row with captured variables opens a viewer with a
 * GUI (name/value cards) tab and a Raw (read-only CodeMirror JSON) tab. This
 * module powers both the run-detail modal and the variable inspector.
 *
 * @module workflow-editor/sidebar/log-view
 */

import { useState } from 'react'
import CodeEditor from '../ui/CodeEditor'

export type StepKind = 'tool' | 'status' | 'result' | 'error' | 'info'

export interface Step {
  at: number
  kind: StepKind
  text: string
  nodeId?: string
  label?: string
  vars?: Record<string, unknown>
}

export interface Snapshot {
  nodeId: string
  label: string
  at: number
  variables: Record<string, unknown>
}

export interface RunView {
  runId: string
  label: string
  source: string
  startedAt: number
  finishedAt?: number
  outcome?: 'ok' | 'failed' | 'cancelled' | 'skipped'
  summary?: string
  error?: string
  steps: Step[]
  snapshots?: Snapshot[]
}

export function clock(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString('en-GB', { hour12: false })
  } catch {
    return ''
  }
}

export function when(ts: number): string {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ''
  }
}

/** One timeline entry: a block execution with its output lines + variables. */
export interface TraceEntry {
  /** Step kind that sets the row's type colour/icon (Automa logsType). */
  type: 'tool' | 'success' | 'error' | 'finish' | 'stop' | 'info'
  nodeId?: string
  label: string
  description: string
  at: number
  /** Duration of the block in milliseconds (Automa shows it next to time). */
  durationMs?: number
  lines: { kind: StepKind; text: string }[]
  vars?: Record<string, unknown>
}

/**
 * Flatten a run's steps + snapshots into Automa-style timeline entries. The
 * "tool" step marks a block boundary; its following output lines attach to it.
 */
export function buildTrace(run: RunView): TraceEntry[] {
  const entries: TraceEntry[] = []
  const varsByNode = new Map<string, Record<string, unknown>>()
  for (const s of run.snapshots ?? []) varsByNode.set(s.nodeId, s.variables)

  let current: TraceEntry | null = null

  const closeCurrent = (nextStart?: number) => {
    if (current) {
      const end = nextStart ?? run.finishedAt
      if (end && end > current.at) current.durationMs = end - current.at
      entries.push(current)
    }
  }

  for (const step of run.steps ?? []) {
    if (step.kind === 'tool') {
      closeCurrent(step.at)
      current = {
        type: 'tool',
        nodeId: step.nodeId,
        label: step.label || step.text || 'block',
        description: '',
        at: step.at,
        lines: [],
        vars: step.vars ?? (step.nodeId ? varsByNode.get(step.nodeId) : undefined),
      }
    } else if (current) {
      current.lines.push({ kind: step.kind, text: step.text })
      if (step.kind === 'error') current.type = 'error'
    } else {
      // Pre-block line (run status etc.): surface as a standalone entry.
      entries.push({
        type: step.kind === 'error' ? 'error' : 'info',
        label: '',
        description: step.text,
        at: step.at,
        lines: [],
      })
    }
  }
  closeCurrent()

  // Mark blocks that never reported an error as success; the final block of a
  // failed run keeps its error colour.
  for (const e of entries) {
    if (e.type === 'tool') e.type = 'success'
  }
  if (run.outcome === 'cancelled') {
    const last = entries[entries.length - 1]
    if (last && last.type !== 'error') last.type = 'stop'
  }
  return entries
}

export function durationLabel(ms?: number): string {
  if (!ms || ms <= 0) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

const TYPE_STYLE: Record<TraceEntry['type'], { icon: string; cls: string }> = {
  tool: { icon: 'ri-play-circle-line', cls: 'wf-console-info' },
  success: { icon: 'ri-check-line', cls: 'wf-console-success' },
  error: { icon: 'ri-error-warning-fill', cls: 'wf-console-error' },
  finish: { icon: 'ri-flag-line', cls: 'wf-console-finish' },
  stop: { icon: 'ri-stop-line', cls: 'wf-console-stop' },
  info: { icon: 'ri-information-line', cls: 'wf-console-info' },
}

function preview(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** The variables-at-block viewer: GUI (name/value cards) + Raw JSON tabs. */
export function VariablesInspector({ vars, onBack }: { vars: Record<string, unknown>; onBack: () => void }) {
  const [tab, setTab] = useState<'gui' | 'raw'>('gui')
  const entries = Object.entries(vars ?? {})
  return (
    <div className="wf-vars-inspector">
      <div className="wf-vars-head">
        <button type="button" className="wf-icon-btn" title="Back to log" onClick={onBack}>
          <i className="ri-arrow-left-line" />
        </button>
        <i className="ri-braces-line" />
        <span>Variables</span>
        <span className="wf-vars-spacer" />
        <div className="wf-modal-tabs">
          <button
            type="button"
            className={`wf-modal-tab${tab === 'gui' ? ' wf-modal-tab-active' : ''}`}
            onClick={() => setTab('gui')}
          >
            GUI
          </button>
          <button
            type="button"
            className={`wf-modal-tab${tab === 'raw' ? ' wf-modal-tab-active' : ''}`}
            onClick={() => setTab('raw')}
          >
            Raw
          </button>
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="wf-console-empty">No variables at this point.</p>
      ) : tab === 'raw' ? (
        <div className="wf-vars-raw">
          <CodeEditor value={JSON.stringify(vars, null, 2)} lang="json" readOnly height="360px" />
        </div>
      ) : (
        <div className="wf-vars-cards">
          {entries.map(([k, v]) => (
            <div key={k} className="wf-var-card">
              <label>{k}</label>
              <input readOnly value={preview(v)} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** A single dark-console timeline row (Automa LogsHistory line). */
export function TraceRow({
  entry,
  debug,
  onInspect,
}: {
  entry: TraceEntry
  debug: boolean
  onInspect: (vars: Record<string, unknown>) => void
}) {
  const style = TYPE_STYLE[entry.type]
  const hasVars = debug && entry.vars && Object.keys(entry.vars).length > 0
  const errorLines = entry.lines.filter((l) => l.kind === 'error')
  const otherLines = entry.lines.filter((l) => l.kind !== 'error')
  const [openError, setOpenError] = useState(false)
  const clickable = hasVars || entry.lines.length > 0
  return (
    <div
      className={`wf-console-row${clickable ? ' wf-console-row-clickable' : ''}`}
      onClick={() => {
        if (hasVars) onInspect(entry.vars!)
      }}
    >
      <span className="wf-console-time" title={when(entry.at)}>
        {clock(entry.at)}
        {entry.durationMs ? <em className="wf-console-dur"> ({durationLabel(entry.durationMs)})</em> : ''}
      </span>
      <i className={`wf-console-icon ${style.icon} ${style.cls}`} />
      <span className="wf-console-main">
        <span className="wf-console-name">{entry.label}</span>
        {entry.description && <span className="wf-console-desc">{entry.description}</span>}
        {otherLines.map((l, i) => (
          <span key={i} className="wf-console-desc wf-console-line">
            {l.text}
          </span>
        ))}
        {errorLines.map((l, i) => (
          <span key={i} className="wf-console-errorline">
            <button
              type="button"
              className="wf-console-errtoggle"
              onClick={(e) => {
                e.stopPropagation()
                setOpenError((o) => !o)
              }}
            >
              {l.text.split('\n')[0]}
              {l.text.includes('\n') && (
                <i className={`ri-arrow-${openError ? 'up' : 'down'}-s-line`} />
              )}
            </button>
            {openError && <pre className="wf-console-errdetail">{l.text}</pre>}
          </span>
        ))}
      </span>
      {hasVars && <i className="ri-braces-line wf-console-vars" title="Inspect variables" />}
    </div>
  )
}
