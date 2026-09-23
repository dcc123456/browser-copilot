/**
 * Failure center dialog — single-entry AI repair flow (spec §11 · Commit 11).
 *
 * Drives the recovery protocol through ONE CTA and never exposes the internal
 * ANALYZE / SUGGEST / AUTO_REPAIR modes:
 *
 * ```text
 * START (diagnose → proposal)
 *   AWAIT_REPAIR_CONFIRM  → [Confirm repair] [Cancel]
 * CONFIRM_REPAIR (apply → verify)
 *   AWAIT_OVERWRITE_CONFIRM → [Overwrite workflow] [Not now]
 * CONFIRM_OVERWRITE → done
 * ```
 *
 * The formal workflow stays immutable outside the two confirmation points.
 * Styling uses semantic Tailwind tokens; all copy goes through i18n.
 *
 * @module sidepanel/FailureCenter
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  CheckCircle2,
  Loader2,
  TriangleAlert,
  X,
  UserRound,
} from 'lucide-react'
import { sendCommand } from '../lib/messages'
import type { CommandResult } from '../lib/messages'
import type {
  RecoveryPhaseState,
  RecoveryProtocolStatus,
} from '../lib/workflow/recovery-protocol'
import { newRecoveryRequestId } from '../lib/workflow/recovery-protocol'
import { useT } from './i18n'

type RecoveryResult = Extract<CommandResult, { type: 'workflows.recovery' }>

interface FailureCenterState {
  requestId: string
  phase: RecoveryPhaseState
  status: RecoveryProtocolStatus
  summary: string
}

export interface FailureCenterDialogProps {
  runId: string
  workflowId: string
  workflowRevision?: number
  onClose: () => void
}

function sendRecovery(
  requestId: string,
  runId: string,
  workflowId: string,
  action: 'START' | 'CONFIRM_REPAIR' | 'CONFIRM_OVERWRITE' | 'CANCEL',
  workflowRevision?: number,
): Promise<RecoveryResult> {
  return sendCommand({
    type: 'workflows.recovery',
    requestId,
    runId,
    workflowId,
    ...(typeof workflowRevision === 'number' ? { workflowRevision } : {}),
    timestamp: Date.now(),
    action,
  }) as Promise<RecoveryResult>
}

function PhaseGlyph({ phase, status }: { phase: RecoveryPhaseState; status: RecoveryProtocolStatus }): ReactNode {
  if (phase === 'DONE') return <CheckCircle2 className="h-5 w-5 text-ok" aria-hidden />
  if (phase === 'FAILED') return <TriangleAlert className="h-5 w-5 text-err" aria-hidden />
  if (phase === 'HUMAN_TAKEOVER') return <UserRound className="h-5 w-5 text-warn" aria-hidden />
  if (status === 'running') return <Loader2 className="h-5 w-5 animate-spin text-accent" aria-hidden />
  return <Loader2 className="h-5 w-5 text-muted" aria-hidden />
}

/** Modal orchestrating the single-entry recovery flow. */
export function FailureCenterDialog({
  runId,
  workflowId,
  workflowRevision,
  onClose,
}: FailureCenterDialogProps): ReactNode {
  const t = useT()
  const [state, setState] = useState<FailureCenterState | null>(null)
  const [error, setError] = useState<string | null>(null)

  // One request for the whole flow; created once.
  const [requestId] = useState(() => newRecoveryRequestId(workflowId))

  const run = useCallback(
    async (action: 'START' | 'CONFIRM_REPAIR' | 'CONFIRM_OVERWRITE' | 'CANCEL') => {
      setError(null)
      try {
        const result = await sendRecovery(requestId, runId, workflowId, action, workflowRevision)
        setState({
          requestId: result.requestId,
          phase: result.phase,
          status: result.status,
          summary: result.summary,
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [requestId, runId, workflowId, workflowRevision],
  )

  // Diagnose → proposal automatically on open; no user choice of mode.
  useEffect(() => {
    void run('START')
  }, [run])

  const phase = state?.phase ?? 'DIAGNOSING'
  const waitingRepair = phase === 'AWAIT_REPAIR_CONFIRM'
  const waitingOverwrite = phase === 'AWAIT_OVERWRITE_CONFIRM'
  const terminal = phase === 'DONE' || phase === 'CANCELLED'
  const busy = state?.status === 'running'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t.failureCenterTitle}
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-panel shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="m-0 text-sm font-semibold text-ink">{t.failureCenterTitle}</h2>
          <button
            className="rounded-md p-1 text-muted hover:bg-hover hover:text-ink"
            onClick={onClose}
            type="button"
            aria-label={t.failureCenterCancel}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-4 py-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 inline-flex shrink-0">
              <PhaseGlyph phase={phase} status={state?.status ?? 'running'} />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-medium text-ink">{phase}</span>
              {state?.summary && (
                <span className="break-words text-xs text-muted">{state.summary}</span>
              )}
              {error && (
                <span className="break-words text-xs text-err" role="alert">
                  {error}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
          {waitingRepair && (
            <>
              <button
                className="rounded-md border border-border px-3 py-1.5 text-xs text-muted hover:bg-hover"
                disabled={busy}
                onClick={() => void run('CANCEL')}
                type="button"
              >
                {t.failureCenterCancel}
              </button>
              <button
                className="rounded-md bg-accent px-3 py-1.5 text-xs text-white"
                disabled={busy}
                onClick={() => void run('CONFIRM_REPAIR')}
                type="button"
              >
                {t.failureCenterConfirmRepair}
              </button>
            </>
          )}

          {waitingOverwrite && (
            <>
              <button
                className="rounded-md border border-border px-3 py-1.5 text-xs text-muted hover:bg-hover"
                disabled={busy}
                onClick={onClose}
                type="button"
              >
                {t.failureCenterKeepCurrent}
              </button>
              <button
                className="rounded-md bg-accent px-3 py-1.5 text-xs text-white"
                disabled={busy}
                onClick={() => void run('CONFIRM_OVERWRITE')}
                type="button"
              >
                {t.failureCenterConfirmOverwrite}
              </button>
            </>
          )}

          {(terminal || phase === 'FAILED' || phase === 'HUMAN_TAKEOVER' || !state) && (
            <button
              className="rounded-md bg-accent px-3 py-1.5 text-xs text-white"
              onClick={onClose}
              type="button"
            >
              {t.failureCenterClose}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
