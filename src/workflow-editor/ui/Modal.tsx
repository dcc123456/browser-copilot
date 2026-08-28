/**
 * Editor modal — a lightweight overlay dialog for the workflow editor.
 *
 * React port of Automa's modal surface (block settings, logs viewer). Renders a
 * centered, scrollable panel over a dimmed backdrop; closes on backdrop click
 * or Escape. The panel is `nodrag` so React Flow never starts a canvas drag from
 * an interaction inside it. Used for the block settings/on-error dialog and the
 * run-logs/debug viewer.
 *
 * @module workflow-editor/ui/Modal
 */

import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { BlockIcon } from '../../lib/workflow/blocks/icons'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  /** Optional leading remix-icon class for the title row. */
  icon?: string
  /** Optional node/block accent colour (CSS colour) for the icon chip. */
  accent?: string
  /** Extra nodes rendered in the title row (right-aligned actions). */
  actions?: ReactNode
  /** Width class; defaults to a medium dialog. */
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** Hide the default close (X) button. */
  hideClose?: boolean
  children: ReactNode
}

const SIZE_CLASS: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'wf-modal-sm',
  md: 'wf-modal-md',
  lg: 'wf-modal-lg',
  xl: 'wf-modal-xl',
}

export default function Modal({
  open,
  onClose,
  title,
  icon,
  accent,
  actions,
  size = 'md',
  hideClose,
  children,
}: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  // Port to <body> so the dialog is a GLOBAL overlay regardless of where it is
  // mounted (e.g. inside the narrow right edit sidebar). Without this the
  // absolute-positioned backdrop is clipped to / positioned over the sidebar,
  // making the JS-code modal look small. Mirrors Automa's <teleport to="body">.
  return createPortal(
    <div
      className="wf-modal-backdrop nodrag"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`wf-modal ${SIZE_CLASS[size]}`}
        role="dialog"
        aria-modal="true"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="wf-modal-head">
          {icon && (
            <span className="wf-modal-icon" style={accent ? { ['--cat-color' as string]: accent } : undefined}>
              <BlockIcon icon={icon} size={16} />
            </span>
          )}
          <p className="wf-modal-title">{title}</p>
          <span className="wf-modal-head-actions">{actions}</span>
          {!hideClose && (
            <button type="button" className="wf-icon-btn wf-modal-close" title="Close" onClick={onClose}>
              <i className="ri-close-line" />
            </button>
          )}
        </div>
        <div className="wf-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
