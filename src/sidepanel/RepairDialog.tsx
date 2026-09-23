/**
 * Unified repair result dialog (spec §12).
 *
 * Renders the serialized {@link RepairResponseData}: failed node vs root
 * cause node, variable dependencies, the minimal patch (before → after),
 * replay/verification state and the commit / discard actions. Pure
 * presentation — the owning tab triggers the commands.
 *
 * Tailwind semantic tokens only (light + dark); status is conveyed with an
 * icon AND text, never color alone.
 *
 * @module sidepanel/RepairDialog
 */

import { useEffect } from 'react'
import { CheckCircle2, CircleSlash, XCircle, Sparkles, TriangleAlert, X } from 'lucide-react'
import type {
  RepairPatchRow,
  RepairResponseData,
  RepairVariableRow,
} from '../lib/workflow/repair/repair-response'
import { useT } from './i18n'

function VariableStatusBadge({
  status,
  t,
}: {
  status: RepairVariableRow['status']
  t: ReturnType<typeof useT>
}) {
  const map = {
    ok: {
      label: t.workflowsRepairStatusOk,
      className: 'text-ok',
      icon: <CheckCircle2 size={13} aria-hidden />,
    },
    missing: {
      label: t.workflowsRepairStatusMissing,
      className: 'text-err',
      icon: <XCircle size={13} aria-hidden />,
    },
    empty: {
      label: t.workflowsRepairStatusEmpty,
      className: 'text-warn',
      icon: <CircleSlash size={13} aria-hidden />,
    },
    type: {
      label: t.workflowsRepairStatusType,
      className: 'text-warn',
      icon: <TriangleAlert size={13} aria-hidden />,
    },
  } as const
  const entry = map[status]
  return (
    <span
      className={`inline-flex flex-none items-center gap-1 text-[11.5px] font-medium ${entry.className}`}
    >
      {entry.icon}
      {entry.label}
    </span>
  )
}

/** Truncate a value for the patch preview. */
function previewValue(value: unknown): string {
  if (value === undefined) return '∅'
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 80)}…` : value
  try {
    const text = JSON.stringify(value)
    return text.length > 80 ? `${text.slice(0, 80)}…` : text
  } catch {
    return String(value)
  }
}

function PatchRowView({ row }: { row: RepairPatchRow }) {
  return (
    <li className="rounded-lg border border-border bg-panel-2 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[12px] font-semibold text-ink">
          {row.nodeId}
          <span className="text-muted"> · {row.path}</span>
        </span>
      </div>
      <div className="mt-1 grid gap-0.5 text-[11.5px] leading-relaxed">
        <span className="flex gap-1.5">
          <span className="flex-none text-muted">−</span>
          <span className="min-w-0 break-words text-muted line-through decoration-err/60">
            {previewValue(row.before)}
          </span>
        </span>
        <span className="flex gap-1.5">
          <span className="flex-none text-ok">+</span>
          <span className="min-w-0 break-words text-ink">{previewValue(row.after)}</span>
        </span>
      </div>
      {row.reason && <p className="m-0 mt-1 text-[11px] leading-snug text-muted">{row.reason}</p>}
    </li>
  )
}

export interface RepairDialogProps {
  data: RepairResponseData
  busy: boolean
  onClose: () => void
  onCommit: () => void
  onDiscard: () => void
  /** Apply the proposed patch after the user accepts the low confidence. */
  onConfirmLowConfidence: () => void
}

/** Modal showing the unified repair outcome. */
export function RepairDialog({
  data,
  busy,
  onClose,
  onCommit,
  onDiscard,
  onConfirmLowConfidence,
}: RepairDialogProps) {
  const t = useT()

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const verified = data.verified
  const canCommit = data.mode === 'AUTO_REPAIR' && verified
  const percent = Math.round(data.confidence * 100)
  const needsConfirmation = data.needsConfirmation === true

  return (
    <div
      className="fixed inset-0 z-[1100] flex items-start justify-center p-4 pt-[7vh]"
      role="presentation"
    >
      <div className="absolute inset-0 bg-slate-950/55 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.workflowsRepairTitle}
        className="relative flex max-h-[86vh] w-full max-w-[380px] flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-[var(--bc-shadow)]"
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-accent-soft text-accent">
            <Sparkles size={16} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="m-0 truncate text-[14px] font-semibold text-ink">
              {t.workflowsRepairTitle}
            </h2>
            <p className="m-0 text-[11.5px] text-muted">
              {t.workflowsRepairConfidence({ percent })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.workflowsRepairClose}
            className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-ink"
          >
            <X size={15} aria-hidden />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-4 py-3.5">
          {/* Low-confidence confirmation banner (P2) */}
          {needsConfirmation && (
            <section
              role="alert"
              className="grid gap-2 rounded-lg border border-warn/50 bg-warn/10 px-3 py-2.5"
            >
              <p className="m-0 flex items-start gap-1.5 text-[12px] font-medium leading-snug text-warn">
                <TriangleAlert size={14} className="mt-px flex-none" aria-hidden />
                {t.workflowsRepairLowConfidenceTitle}
              </p>
              <p className="m-0 text-[11.5px] leading-relaxed text-muted">
                {data.reason || t.workflowsRepairLowConfidenceHint}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={onConfirmLowConfidence}
                className="h-8 cursor-pointer rounded-lg border border-warn/60 bg-warn/15 px-3 text-[12.5px] font-semibold text-warn transition-colors hover:bg-warn/25 disabled:cursor-default disabled:opacity-60"
              >
                {busy ? t.workflowsRepairRunning : t.workflowsRepairLowConfidenceAccept}
              </button>
            </section>
          )}
          {/* Symptom vs root cause */}
          <section className="grid gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                {t.workflowsRepairFailedNode}
              </span>
              <span className="font-mono text-[12px] text-ink">{data.failedNodeId}</span>
            </div>
            <div className="flex items-start justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                {t.workflowsRepairRootCause}
              </span>
              <span className="flex flex-wrap justify-end gap-1">
                {data.rootCauseNodeIds.length > 0 ? (
                  data.rootCauseNodeIds.map((nodeId) => (
                    <span
                      key={nodeId}
                      className="rounded-md bg-accent-soft px-1.5 py-0.5 font-mono text-[11.5px] font-medium text-accent"
                    >
                      {nodeId}
                    </span>
                  ))
                ) : (
                  <span className="text-[11.5px] text-muted">—</span>
                )}
              </span>
            </div>
            <p className="m-0 mt-0.5 rounded-lg bg-panel-2 px-2.5 py-2 text-[12px] leading-relaxed text-ink">
              {data.explanation}
            </p>
            {data.retryRecommended && (
              <p className="m-0 flex items-start gap-1.5 text-[11.5px] leading-snug text-warn">
                <TriangleAlert size={13} className="mt-0.5 flex-none" aria-hidden />
                {t.workflowsRepairRetryHint}
              </p>
            )}
          </section>

          {/* Variable dependencies */}
          {data.variableRows.length > 0 && (
            <section>
              <h3 className="m-0 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                {t.workflowsRepairVariables}
              </h3>
              <ul className="grid gap-1">
                {data.variableRows.map((row) => (
                  <li
                    key={`${row.variable}-${row.producerNodeId ?? ''}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border bg-panel-2 px-2.5 py-1.5"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-mono text-[12px] text-ink">
                        {row.variable}
                      </span>
                      {row.producerNodeId && (
                        <span className="flex-none font-mono text-[10.5px] text-muted">
                          ← {row.producerNodeId}
                        </span>
                      )}
                    </span>
                    <VariableStatusBadge status={row.status} t={t} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Patch preview */}
          {data.patchRows.length > 0 && (
            <section>
              <h3 className="m-0 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                {t.workflowsRepairPatch} · {t.workflowsRepairBeforeAfter}
              </h3>
              <ul className="grid gap-1.5">
                {data.patchRows.map((row, index) => (
                  <PatchRowView key={`${row.nodeId}-${row.path}-${index}`} row={row} />
                ))}
              </ul>
            </section>
          )}

          {/* Replay / verification state */}
          <section>
            <h3 className="m-0 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              {t.workflowsRepairReplay} / {t.workflowsRepairVerification}
            </h3>
            <div
              className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 ${
                verified ? 'border-ok/40 bg-ok-surface' : 'border-border bg-panel-2'
              }`}
            >
              {verified ? (
                <CheckCircle2 size={15} className="mt-0.5 flex-none text-ok" aria-hidden />
              ) : (
                <XCircle size={15} className="mt-0.5 flex-none text-err" aria-hidden />
              )}
              <p className="m-0 text-[12px] leading-relaxed text-ink">
                {verified ? t.workflowsRepairVerified : t.workflowsRepairNotVerified}
              </p>
            </div>
          </section>

          {data.warnings.length > 0 && (
            <section>
              <ul className="grid gap-1">
                {data.warnings.map((warning, index) => (
                  <li key={index} className="text-[11.5px] leading-snug text-warn">
                    · {warning}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(data.reason || data.error) && (
            <p className="m-0 rounded-lg bg-err-surface px-2.5 py-2 text-[12px] leading-relaxed text-err">
              {data.reason || data.error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            disabled={busy}
            onClick={onDiscard}
            className="h-8 cursor-pointer rounded-lg border border-border bg-panel-2 px-3 text-[12.5px] font-medium text-muted transition-colors hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-60"
          >
            {t.workflowsRepairDiscard}
          </button>
          <button
            type="button"
            disabled={busy || !canCommit}
            onClick={onCommit}
            className="h-8 cursor-pointer rounded-lg border border-accent bg-accent px-3.5 text-[12.5px] font-semibold text-on-accent transition-colors hover:bg-accent-strong disabled:cursor-default disabled:border-border disabled:bg-panel-2 disabled:text-muted"
            title={canCommit ? undefined : t.workflowsRepairNotVerified}
          >
            {busy ? t.workflowsRepairRunning : t.workflowsRepairCommit}
          </button>
        </div>
      </div>
    </div>
  )
}
