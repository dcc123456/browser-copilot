/**
 * Custom modal dialog — a Tailwind-built replacement for the native
 * `window.confirm()` / `window.alert()` calls.
 *
 * Two layers:
 *  - `useConfirm()` returns `confirm()`, `alert()` and the `node` to render.
 *  - Most code uses the module-level `confirmDialog()` / `alertDialog()` API
 *    from `./confirm` after mounting `<ConfirmHost />` once.
 *
 * The promise resolves `true`/`false` for confirms; `alert` resolves on close.
 * Backdrop click and Escape cancel (they acknowledge `alert`).
 *
 * @module ui/ConfirmDialog
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export interface ConfirmOptions {
  /** Heading, e.g. "Delete conversation?". */
  title: string
  /** Body text / question. */
  message?: string
  /** Confirm button label; defaults to "OK"/"Confirm". */
  confirmText?: string
  /** Cancel button label; defaults to "Cancel". */
  cancelText?: string
  /** Use the destructive styling for the confirm button. */
  danger?: boolean
  /** Alert mode: single "OK" button, no cancel. */
  alert?: boolean
}

interface OpenDialog extends ConfirmOptions {
  resolve: (value: boolean) => void
}

export function useConfirm(): {
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  alert: (opts: ConfirmOptions) => Promise<void>
  node: React.ReactElement | null
} {
  const [queue, setQueue] = useState<OpenDialog[]>([])
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const dialog = queue[0] ?? null

  const open = useCallback((opts: ConfirmOptions, resolve: (v: boolean) => void) => {
    setQueue((q) => [...q, { ...opts, resolve }])
  }, [])

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => open({ ...opts, alert: false }, resolve)),
    [open],
  )

  const alert = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<void>((resolve) =>
        open({ ...opts, alert: true, danger: opts.danger ?? true }, () => resolve()),
      ),
    [open],
  )

  const close = useCallback((result: boolean) => {
    setQueue((q) => {
      q[0]?.resolve(result)
      return q.slice(1)
    })
  }, [])

  // Focus the primary action on open; handle Escape at the dialog level.
  useEffect(() => {
    if (!dialog) return
    const t = window.setTimeout(() => confirmRef.current?.focus(), 40)
    return () => window.clearTimeout(t)
  }, [dialog])

  useEffect(() => {
    if (!dialog) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close(!!dialog.alert)
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        close(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [dialog, close])

  const node = dialog ? (
    <div
      className="fixed inset-0 z-[1000] flex items-start justify-center p-4 pt-[9vh]"
      role="presentation"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-slate-950/55 backdrop-blur-[2px] animate-[dialog-fade_140ms_ease-out]"
        onClick={() => close(!!dialog.alert)}
      />
      {/* Panel */}
      <div
        role={dialog.alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-label={dialog.title}
        className="relative w-full max-w-[320px] rounded-xl border border-border bg-panel shadow-[var(--bc-shadow)] p-4 animate-[dialog-slide-down_180ms_ease-out]"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className={[
              'mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-full',
              dialog.danger ? 'bg-err-surface text-err' : 'bg-accent-soft text-accent',
            ].join(' ')}
          >
            {dialog.danger ? (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            ) : (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-[14px] font-semibold leading-snug text-ink">
              {dialog.title}
            </h2>
            {dialog.message && (
              <p className="m-0 mt-1.5 whitespace-pre-line text-[12.5px] leading-relaxed text-muted break-words">
                {dialog.message}
              </p>
            )}
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          {!dialog.alert && (
            <button
              type="button"
              onClick={() => close(false)}
              className="h-8 cursor-pointer rounded-lg border border-border bg-panel-2 px-3.5 text-[13px] font-medium text-muted transition-colors duration-150 hover:bg-hover hover:text-ink"
            >
              {dialog.cancelText ?? 'Cancel'}
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            onClick={() => close(true)}
            className={[
              'h-8 cursor-pointer rounded-lg px-3.5 text-[13px] font-semibold transition-colors duration-150',
              dialog.danger
                ? 'border border-err bg-err text-white hover:brightness-110'
                : 'border border-accent bg-accent text-on-accent hover:bg-accent-strong',
            ].join(' ')}
          >
            {dialog.confirmText ?? (dialog.alert ? 'OK' : 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  ) : null

  return { confirm, alert, node }
}
