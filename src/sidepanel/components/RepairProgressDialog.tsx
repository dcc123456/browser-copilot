/**
 * Repair progress dialog (spec §31.2, Commit 15).
 *
 * The run-failure UI. Instead of immediately offering a human takeover, an
 * ordinary failure shows the autonomous repair at work:
 *
 * ```text
 * AI is auto-repairing …
 *   ✓ analyzed the failed step
 *   ✓ inspected the current page
 *   ⟳ locating an available target
 * ```
 *
 * Success reports the fix summary + verification detail; only the genuine
 * blocked/exhausted states offer the human takeover. Portal-rendered on
 * `document.body`; Tailwind semantic tokens only, all copy through i18n.
 *
 * @module sidepanel/components/RepairProgressDialog
 */
import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  CheckCircle2,
  CircleDashed,
  Loader2,
  TriangleAlert,
  UserRound,
  X,
} from 'lucide-react'
import type { RepairProgressEvent } from '../../lib/workflow/repair-events'
import { repairEventIsTerminal } from '../../lib/workflow/repair-events'
import { useT } from '../i18n'

export interface RepairProgressDialogProps {
  open: boolean
  workflowId: string
  /** Events accumulated for this repair, in order. */
  events: RepairProgressEvent[]
  onClose: () => void
  /** Human takeover action (blocked / exhausted states only). */
  onHumanTakeover: () => void
}

type DerivedState = 'running' | 'success' | 'exhausted' | 'blocked'

function stateOf(events: RepairProgressEvent[]): DerivedState {
  const last = events.at(-1)
  if (!last) return 'running'
  if (last.type === 'repair.success') return 'success'
  if (last.type === 'repair.exhausted') return 'exhausted'
  if (last.type === 'repair.blocked') return 'blocked'
  return 'running'
}

/** Collapse the event stream into a short step list for the UI. */
function stepRowsOf(
  events: RepairProgressEvent[],
  t: ReturnType<typeof useT>,
): Array<{ key: string; status: 'done' | 'running' | 'pending'; text: string }> {
  const rows: Array<{ key: string; status: 'done' | 'running' | 'pending'; text: string }> = []
  for (const event of events) {
    if (event.type === 'repair.diagnosing') {
      rows.push({ key: `${event.type}-${event.sessionId}-${event.attempt}`, status: 'done', text: t.workflowRepairDiagnosing })
    } else if (event.type === 'repair.applying') {
      rows.push({ key: `${event.type}-${event.sessionId}-${event.strategy}`, status: 'done', text: t.workflowRepairApplying })
    } else if (event.type === 'repair.verifying') {
      rows.push({ key: `${event.type}-${event.sessionId}`, status: 'running', text: t.workflowRepairVerifying })
    }
  }
  // Mark all but the last running row done.
  let lastRunningSeen = false
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!
    if (row.status === 'running') {
      if (lastRunningSeen) row.status = 'done'
      lastRunningSeen = true
    }
  }
  if (rows.length === 0) {
    rows.push({ key: 'starting', status: 'running', text: t.workflowRepairStarting })
  }
  return rows.slice(-6)
}

function RowGlyph({ status }: { status: 'done' | 'running' | 'pending' }): ReactNode {
  if (status === 'done') return <CheckCircle2 className="h-4 w-4 text-ok" aria-hidden />
  if (status === 'running') return <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />
  return <CircleDashed className="h-4 w-4 text-muted" aria-hidden />
}

export function RepairProgressDialog(props: RepairProgressDialogProps): ReactNode {
  const { open, events } = props
  const t = useT()
  const state = stateOf(events)
  const terminal = state !== 'running'

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, props])

  if (!open) return null

  const rows = stepRowsOf(events, t)
  const lastEvent = events.at(-1)
  const detail =
    lastEvent && 'reason' in lastEvent ? lastEvent.reason : undefined
  const revision =
    lastEvent?.type === 'repair.success' ? lastEvent.revision : undefined

  let title: string
  if (state === 'success') title = t.workflowRepairSuccess
  else if (state === 'exhausted') title = t.workflowRepairExhausted
  else if (state === 'blocked') title = t.workflowRepairBlocked
  else title = t.workflowRepairAutoTitle

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[85vh] w-full max-w-sm flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="flex items-center gap-2 truncate text-sm font-semibold text-ink">
            {state === 'blocked' || state === 'exhausted' ? (
              <UserRound className="h-4 w-4 text-warn" aria-hidden />
            ) : state === 'success' ? (
              <CheckCircle2 className="h-4 w-4 text-ok" aria-hidden />
            ) : (
              <TriangleAlert className="h-4 w-4 text-accent" aria-hidden />
            )}
            {title}
          </h2>
          <button
            type="button"
            onClick={props.onClose}
            className="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-ink"
            aria-label={t.workflowGenerationClose}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          <ul className="m-0 flex flex-col gap-1.5 p-0">
            {rows.map((row) => (
              <li key={row.key} className="flex items-start gap-2">
                <span className="mt-0.5 flex flex-none">
                  <RowGlyph status={row.status} />
                </span>
                <span className="text-[13px] text-ink">{row.text}</span>
              </li>
            ))}
          </ul>

          {detail ? (
            <p className="m-0 text-xs text-muted break-words">{detail}</p>
          ) : null}

          {state === 'success' ? (
            <p className="m-0 text-[11.5px] text-muted">
              {revision !== undefined
                ? t.workflowRepairRevisionCommitted({ revision })
                : t.workflowRepairVerifiedDetail}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          {state === 'blocked' || state === 'exhausted' ? (
            <button
              type="button"
              onClick={props.onHumanTakeover}
              className="h-8 rounded-lg bg-accent px-3.5 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-strong"
            >
              {t.workflowRepairNeedHuman}
            </button>
          ) : null}
          <button
            type="button"
            onClick={props.onClose}
            className="h-8 rounded-lg border border-border bg-panel-2 px-3 text-xs font-medium text-muted transition-colors hover:bg-hover hover:text-ink"
          >
            {terminal ? t.workflowGenerationClose : t.workflowGenerationBackground}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Whether a streamed event settles the repair (used by the subscriber hook). */
export function isTerminalRepairEvent(type: RepairProgressEvent['type']): boolean {
  return repairEventIsTerminal(type)
}
