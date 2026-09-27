/**
 * Workflow generation dialog (spec §10, §31.1, §33, Commit 3).
 *
 * The generation UI as a portal modal rendered on `document.body`, outside
 * the chat layout: opening/closing the dialog never moves the chat and never
 * cancels the generation — the session lives in the background. The dialog
 * is the LOADING surface for a workflow-mode task, rendering the lifecycle:
 *
 * ```text
 * GENERATING → RECOVERING → COMPILING → VALIDATING (or ERROR)
 * ```
 *
 * When the task settles, the save card popup takes over (see ChatTab) — this
 * dialog is only reopened for its log via the card's "generation log" action.
 *
 * Keyboard (spec §10.3):
 *   - Esc while idle/not running closes;
 *   - Esc/close while the generation runs = background (minimize), NOT cancel;
 *   - only the explicit cancel action stops the session.
 *
 * Tailwind semantic tokens only (light + dark); all copy goes through i18n.
 *
 * @module sidepanel/components/WorkflowGenerationDialog
 */
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  CheckCircle2,
  CircleDashed,
  Loader2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useT } from '../i18n'

export type WorkflowGenerationViewState =
  | 'GENERATING'
  | 'RECOVERING'
  | 'COMPILING'
  | 'VALIDATING'
  | 'READY'
  | 'SAVING'
  | 'SAVED'
  | 'ERROR'

export interface WorkflowGenerationProgress {
  state: WorkflowGenerationViewState
  /** The stage list, newest first semantics. */
  stages: Array<{
    key: string
    labelKey: string
    status: 'running' | 'done' | 'pending' | 'warn'
    detail?: string
  }>
  /** Latest action description. */
  latestAction?: string
  actionCount: number
  recoveredCount: number
  /** Generation log lines collected through the whole task. */
  logs?: string[]
}

export interface WorkflowGenerationDialogProps {
  open: boolean
  progress: WorkflowGenerationProgress
  /** Error message when state is ERROR. */
  errorMessage?: string
  /** Minimize/background the dialog (the generation keeps running). */
  onBackground: () => void
  /** Explicitly cancel the generation. */
  onCancel: () => void
  /** Close when the generation ended (ERROR) or was cancelled. */
  onClose: () => void
}

function StageGlyph({ status }: { status: 'running' | 'done' | 'pending' | 'warn' }): ReactNode {
  if (status === 'done') return <CheckCircle2 className="h-4 w-4 text-ok" aria-hidden />
  if (status === 'warn') return <TriangleAlert className="h-4 w-4 text-warn" aria-hidden />
  if (status === 'running') return <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />
  return <CircleDashed className="h-4 w-4 text-muted" aria-hidden />
}

function titleForState(t: ReturnType<typeof useT>, state: WorkflowGenerationViewState): string {
  switch (state) {
    case 'GENERATING':
      return t.workflowGenerationWorking
    case 'RECOVERING':
      return t.workflowGenerationRecovering
    case 'COMPILING':
      return t.workflowGenerationCompiling
    case 'VALIDATING':
      return t.workflowGenerationValidating
    case 'READY':
      return t.workflowGenerationReady
    case 'SAVING':
      return t.workflowGenerationReady
    case 'SAVED':
      return t.workflowGenerationSaved
    case 'ERROR':
      return t.workflowGenerationError
  }
}

/** Whether the background is still doing work (close = background, not cancel). */
const RUNNING_STATES: ReadonlySet<WorkflowGenerationViewState> = new Set<WorkflowGenerationViewState>([
  'GENERATING',
  'RECOVERING',
  'COMPILING',
  'VALIDATING',
  'SAVING',
])

export function WorkflowGenerationDialog(props: WorkflowGenerationDialogProps): ReactNode {
  const { open } = props
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)

  const running = RUNNING_STATES.has(props.progress.state)

  const handleClose = useCallback((): void => {
    if (running) props.onBackground()
    else props.onClose()
  }, [props, running])

  // Esc: close/background when not running-with-no-safe-out; explicit cancel
  // stays a separate button.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        handleClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [handleClose, open])

  const title = useMemo(() => titleForState(t, props.progress.state), [t, props.progress.state])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) handleClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-ink">{title}</h2>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-ink"
            aria-label={running ? t.workflowGenerationBackground : t.workflowGenerationClose}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          {/* Latest action */}
          {props.progress.latestAction ? (
            <p className="m-0 truncate text-xs text-muted" title={props.progress.latestAction}>
              {props.progress.latestAction}
            </p>
          ) : null}

          {/* Stage list */}
          <ul className="m-0 flex flex-col gap-1.5 p-0">
            {props.progress.stages.map((stage) => (
              <li key={stage.key} className="flex items-start gap-2">
                <span className="mt-0.5 flex flex-none">
                  <StageGlyph status={stage.status} />
                </span>
                <div className="flex min-w-0 flex-col">
                  <span className="text-[13px] text-ink">{t[stage.labelKey as keyof typeof t] as string}</span>
                  {stage.detail ? (
                    <span className="text-xs text-muted break-words">{stage.detail}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          {/* Generation log */}
          {props.progress.logs && props.progress.logs.length > 0 ? (
            <details className="group/log rounded-lg border border-border" open>
              <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[12px] font-medium text-ink">
                {t.workflowGenerationLogTitle({ count: props.progress.logs.length })}
              </summary>
              <ul className="m-0 max-h-44 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2">
                {props.progress.logs.map((line, index) => (
                  <li key={`${index}-${line.slice(0, 12)}`} className="break-words font-mono text-[11px] leading-snug text-muted">
                    {line}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {/* Counters */}
          <div className="flex items-center gap-4 text-[11.5px] text-muted">
            <span>{t.workflowGenerationActionCount({ count: props.progress.actionCount })}</span>
            {props.progress.recoveredCount > 0 ? (
              <span>{t.workflowGenerationRecoveredCount({ count: props.progress.recoveredCount })}</span>
            ) : null}
          </div>

          {/* Error (generation failure) */}
          {props.errorMessage ? (
            <div
              className="rounded-lg border border-err/30 bg-err-surface px-3 py-2 text-xs text-err"
              role="alert"
            >
              {props.errorMessage}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          {running ? (
            <>
              <button
                type="button"
                onClick={props.onCancel}
                className="h-8 rounded-lg border border-border bg-panel-2 px-3 text-xs font-medium text-muted transition-colors hover:bg-hover hover:text-ink"
              >
                {t.workflowGenerationCancel}
              </button>
              <button
                type="button"
                onClick={props.onBackground}
                className="h-8 rounded-lg bg-accent px-3 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-strong"
              >
                {t.workflowGenerationBackground}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={props.onClose}
              className="h-8 rounded-lg bg-accent px-3.5 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-strong"
            >
              {t.workflowGenerationClose}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
