/**
 * Generic editing modal for the side panel — the shared shell behind every
 * "edit in a dialog instead of on the page" surface (skill editor, provider
 * editor, model selections, local-agent connection).
 *
 * Shell only: title + scrollable body + optional footer. Buttons, labels and
 * errors come from the caller, so this file stays free of i18n. Visuals match
 * `ConfirmDialog` (backdrop blur, panel border/shadow, slide-down animation);
 * Escape and a backdrop click both trigger `onClose`.
 *
 * @module ui/FormDialog
 */

import { useEffect, useRef, type ReactNode } from 'react'

export interface FormDialogProps {
  /** Heading rendered at the top of the panel. */
  title: string
  /** Called on Escape and on backdrop click — the cancel path. */
  onClose: () => void
  /** Form fields / body content. */
  children: ReactNode
  /** Bottom action row (save / cancel buttons). Omit for body-only dialogs. */
  footer?: ReactNode
  /** Panel width: `md` (default) for short forms, `lg` for the provider editor. */
  width?: 'md' | 'lg'
}

const WIDTH_CLASS: Record<NonNullable<FormDialogProps['width']>, string> = {
  md: 'max-w-[420px]',
  lg: 'max-w-[560px]',
}

export default function FormDialog({
  title,
  onClose,
  children,
  footer,
  width = 'md',
}: FormDialogProps): React.ReactElement {
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Focus the first focusable control so keyboard users land inside the form,
  // and close on Escape — both scoped to the open dialog.
  useEffect(() => {
    const focusable = panelRef.current?.querySelector<HTMLElement>(
      'input, select, textarea, button',
    )
    const timer = window.setTimeout(() => focusable?.focus(), 40)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-start justify-center p-4 pt-[7vh]"
      role="presentation"
    >
      {/* Backdrop click cancels; clicks inside the panel must not reach it. */}
      <div
        aria-hidden
        className="fixed inset-0 bg-slate-950/55 backdrop-blur-[2px] animate-[dialog-fade_140ms_ease-out]"
        onClick={onClose}
      />
      <div
        aria-modal="true"
        aria-label={title}
        className={[
          'relative max-h-[84vh] w-full overflow-y-auto rounded-xl border border-border bg-panel p-4 shadow-[var(--bc-shadow)] animate-[dialog-slide-down_180ms_ease-out]',
          WIDTH_CLASS[width],
        ].join(' ')}
        onClick={(event) => event.stopPropagation()}
        ref={panelRef}
        role="dialog"
      >
        <h2 className="m-0 text-[14px] font-semibold leading-snug text-ink">{title}</h2>
        <div className="mt-3">{children}</div>
        {footer && <div className="mt-4 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}

/** Cancel button styled for FormDialog footers (shared by every caller). */
export function FormDialogCancelButton({
  label,
  disabled,
  onClick,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      className="h-8 cursor-pointer rounded-lg border border-border bg-panel-2 px-3.5 text-[13px] font-medium text-muted transition-colors duration-150 hover:bg-hover hover:text-ink"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  )
}

/** Primary button styled for FormDialog footers (shared by every caller). */
export function FormDialogPrimaryButton({
  label,
  disabled,
  onClick,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      className={[
        'h-8 cursor-pointer rounded-lg border border-accent bg-accent px-3.5 text-[13px] font-semibold text-on-accent transition-colors duration-150 hover:bg-accent-strong',
        disabled ? 'cursor-not-allowed opacity-60' : '',
      ].join(' ')}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  )
}
