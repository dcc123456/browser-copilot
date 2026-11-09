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

import {
  ArrowLeft,
  Braces,
  Check,
  ChevronDown,
  ChevronUp,
  CirclePlay,
  Copy,
  Flag,
  Info,
  Locate,
  Square,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { copyText } from '../../lib/clipboard'
import CodeEditor from '../ui/CodeEditor'
import { useEditorLocale } from '../locale-context'

export type StepKind = 'tool' | 'status' | 'result' | 'error' | 'info'

export interface Step {
  at: number
  kind: StepKind
  text: string
  nodeId?: string
  label?: string
  vars?: Record<string, unknown>
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
 * Flatten a run's steps into Automa-style timeline entries. The "tool" step
 * marks a block boundary; its following output lines attach to it, and debug
 * variables ride on that same step.
 */
export function buildTrace(run: RunView): TraceEntry[] {
  const entries: TraceEntry[] = []

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
        vars: step.vars,
      }
    } else if (current) {
      current.lines.push({ kind: step.kind, text: step.text })
      if (step.kind === 'error') current.type = 'error'
    } else {
      // Pre-block line (run status, a node the run gate stopped on): surface as
      // a standalone entry, keeping its node id so the row can locate it.
      entries.push({
        type: step.kind === 'error' ? 'error' : 'info',
        nodeId: step.nodeId,
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

/**
 * The run as plain text — what "Copy logs" puts on the clipboard.
 *
 * A readable transcript rather than the export's JSON: the clipboard is where
 * it goes next (a chat message, an issue), so the block lines, the error text
 * and (in debug mode) the captured variables have to survive as words. The
 * caller decides WHICH entries to pass — the modal copies the filtered view,
 * exactly what the user is looking at.
 */
export function formatRunLogText(run: RunView, entries: readonly TraceEntry[]): string {
  const lines: string[] = []
  lines.push(`${run.label || 'workflow'} (${run.runId})`)
  const finished = run.finishedAt ? ` → ${when(run.finishedAt)}` : ''
  lines.push(`${run.outcome ?? 'running'} · ${when(run.startedAt)}${finished}`)
  if (run.summary) lines.push(run.summary)
  if (run.error) lines.push(`Error: ${run.error}`)
  lines.push('')
  for (const entry of entries) {
    const head = [
      clock(entry.at),
      entry.durationMs ? `(${durationLabel(entry.durationMs)})` : '',
      entry.label,
      entry.description,
    ]
      .filter(Boolean)
      .join(' ')
    lines.push(head)
    for (const line of entry.lines) {
      lines.push(line.kind === 'error' ? `! ${line.text}` : `  ${line.text}`)
    }
    if (entry.vars && Object.keys(entry.vars).length > 0) {
      // Same renderer as the inspector: a cyclic bag must not silently drop the
      // variables from the transcript the user pastes into a chat.
      lines.push(`  vars: ${valueText(entry.vars)}`)
    }
  }
  return lines.join('\n')
}

const TYPE_STYLE: Record<TraceEntry['type'], { Icon: LucideIcon; cls: string }> = {
  tool: { Icon: CirclePlay, cls: 'wf-console-info' },
  success: { Icon: Check, cls: 'wf-console-success' },
  error: { Icon: TriangleAlert, cls: 'wf-console-error' },
  finish: { Icon: Flag, cls: 'wf-console-finish' },
  stop: { Icon: Square, cls: 'wf-console-stop' },
  info: { Icon: Info, cls: 'wf-console-info' },
}

/**
 * Replace only true cycles. Repeated non-cyclic references are legal JSON and
 * must survive; a container that points back at an ancestor becomes a marker
 * instead of aborting the whole rendering.
 */
function decycle(value: unknown): unknown {
  const ancestors = new WeakSet<object>()
  const walk = (node: unknown): unknown => {
    if (typeof node === 'bigint') return `${node}n`
    if (node === null || typeof node !== 'object') return node
    if (node instanceof Date) return node.toISOString()
    if (ancestors.has(node)) return '[Circular]'
    ancestors.add(node)
    let copy: unknown
    if (Array.isArray(node)) {
      copy = node.map(walk)
    } else {
      const record: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(node)) record[key] = walk(item)
      copy = record
    }
    ancestors.delete(node)
    return copy
  }
  return walk(value)
}

/**
 * Render a captured variable for the inspector. Strings stay verbatim so the
 * copy round-trip adds no quotes; everything else is JSON. A page value can be
 * circular or hold a BigInt, and `JSON.stringify` then throws — the old
 * fallback was `String(value)`, which is how a list of objects displayed as
 * `[object Object],[object Object]` in the cards. Degrade through a decycled
 * copy instead, so the data stays readable.
 */
export function valueText(value: unknown, pretty = false): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'bigint') return `${value}n`
  const space = pretty ? 2 : undefined
  try {
    return JSON.stringify(value, null, space) ?? String(value)
  } catch {
    try {
      return JSON.stringify(decycle(value), null, space) ?? String(value)
    } catch {
      return String(value)
    }
  }
}

/**
 * The full-value dialog opened by clicking a card. It lives inside the run
 * modal's stacking context and sits above the cards, but stays plain DOM rather
 * than a second `Modal`: two nested Modals both listen for Escape on window
 * capture, so one key press would close both.
 */
function VariableDetail({
  name,
  value,
  onClose,
}: {
  name: string
  value: unknown
  onClose: () => void
}) {
  const { bt } = useEditorLocale()
  return (
    <div
      className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/45 p-6"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={name}
        className="flex max-h-[calc(100vh-56px)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border-strong bg-bg shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Braces size={14} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink">{name}</span>
          <VariableCopyButton value={value} />
          <button
            type="button"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-ink"
            title={bt('Close')}
            aria-label={bt('Close')}
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {typeof value === 'string' ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-ink">
              {value}
            </pre>
          ) : (
            <CodeEditor value={valueText(value, true)} lang="json" readOnly height="360px" />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Per-card copy control in the GUI variable view. Each card owns its own
 * confirmation so the user sees WHICH value landed on the clipboard — the
 * icon turns into a check for a moment, matching the header's Copy logs.
 */
function VariableCopyButton({ value }: { value: unknown }) {
  const { bt } = useEditorLocale()
  const [state, setState] = useState<'idle' | 'ok' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(timer)
  }, [state])

  const copy = async () => {
    try {
      await copyText(valueText(value))
      setState('ok')
    } catch {
      setState('failed')
    }
  }

  const label =
    state === 'ok' ? bt('Copied') : state === 'failed' ? bt('Copy failed') : bt('Copy value')
  return (
    <button
      type="button"
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-ink"
      title={label}
      aria-label={label}
      onClick={(event) => {
        // The card opens the full-value dialog; copying is its own action.
        event.stopPropagation()
        void copy()
      }}
    >
      {state === 'ok' ? (
        <Check size={13} />
      ) : state === 'failed' ? (
        <TriangleAlert size={13} className="text-err" />
      ) : (
        <Copy size={13} />
      )}
    </button>
  )
}

/** The variables-at-block viewer: GUI (name/value cards) + Raw JSON tabs. */
export function VariablesInspector({
  vars,
  onBack,
}: {
  vars: Record<string, unknown>
  onBack: () => void
}) {
  const { bt } = useEditorLocale()
  const [tab, setTab] = useState<'gui' | 'raw'>('gui')
  const [detailName, setDetailName] = useState<string | null>(null)
  const entries = Object.entries(vars ?? {})
  const detailValue = detailName !== null ? vars?.[detailName] : undefined
  return (
    <div className="wf-vars-inspector">
      <div className="wf-vars-head">
        <button type="button" className="wf-icon-btn" title={bt('Back to log')} onClick={onBack}>
          <ArrowLeft size={14} />
        </button>
        <Braces size={14} />
        <span>{bt('Variables')}</span>
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
          <CodeEditor value={valueText(vars, true)} lang="json" readOnly height="360px" />
        </div>
      ) : (
        <div className="wf-vars-cards">
          {entries.map(([k, v]) => (
            <div
              key={k}
              role="button"
              tabIndex={0}
              title={bt('Show full value')}
              className="wf-var-card cursor-pointer transition-colors hover:border-accent"
              onClick={() => setDetailName(k)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setDetailName(k)
                }
              }}
            >
              <label>{k}</label>
              <div className="flex items-center gap-1">
                <input readOnly value={valueText(v)} className="min-w-0 flex-1" />
                <VariableCopyButton value={v} />
              </div>
            </div>
          ))}
        </div>
      )}
      {detailName !== null && (
        <VariableDetail name={detailName} value={detailValue} onClose={() => setDetailName(null)} />
      )}
    </div>
  )
}

/** A single dark-console timeline row (Automa LogsHistory line). */
export function TraceRow({
  entry,
  debug,
  onInspect,
  onLocate,
}: {
  entry: TraceEntry
  debug: boolean
  onInspect: (vars: Record<string, unknown>) => void
  /** Center the canvas on this row's node; absent outside the editor. */
  onLocate?: (nodeId: string) => void
}) {
  const style = TYPE_STYLE[entry.type]
  const { bt, t } = useEditorLocale()
  const hasVars = debug && entry.vars && Object.keys(entry.vars).length > 0
  const locateId = entry.nodeId
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
        {entry.durationMs ? (
          <em className="wf-console-dur"> ({durationLabel(entry.durationMs)})</em>
        ) : (
          ''
        )}
      </span>
      <style.Icon size={13} className={`wf-console-icon ${style.cls}`} />
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
              {l.text.includes('\n') &&
                (openError ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
            </button>
            {openError && <pre className="wf-console-errdetail">{l.text}</pre>}
          </span>
        ))}
      </span>
      {hasVars && (
        <span title={bt('Inspect variables')} style={{ display: 'inline-flex' }}>
          <Braces size={13} className="wf-console-vars" />
        </span>
      )}
      {locateId !== undefined && onLocate !== undefined && (
        <button
          type="button"
          className="ml-2 inline-flex shrink-0 items-center gap-1 rounded border border-border bg-accent-soft px-1.5 py-px text-[10px] leading-tight text-accent"
          title={t('locateNode')}
          onClick={(e) => {
            e.stopPropagation()
            onLocate(locateId)
          }}
        >
          <Locate size={11} />
          {t('locateNode')}
        </button>
      )}
    </div>
  )
}
