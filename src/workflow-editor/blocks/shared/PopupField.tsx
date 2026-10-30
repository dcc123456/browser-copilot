/**
 * A labelled summary row that opens its editor in a Modal.
 *
 * Automa edits several block properties in modals while the inline form shows
 * only the current value. The editor inside the modal writes through the same
 * live `onChange` as before: there is no draft state and no Apply button.
 *
 * @module workflow-editor/blocks/shared/PopupField
 */

import { Pencil } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import Modal from '../../ui/Modal'
import { useEditorLocale } from '../../locale-context'

export default function PopupField({
  title,
  summary,
  editLabel = 'Edit',
  icon,
  accent,
  size = 'md',
  variant = 'summary',
  children,
}: {
  /** Modal title (translated through the block dictionary). */
  title: string
  /** One-line current value shown in the form. */
  summary?: ReactNode
  editLabel?: string
  /** Remix icon class for the modal title row. */
  icon?: string
  accent?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /**
   * `summary` = recessed current-value row + small edit button (Automa's
   * summary popups). `button` = full-width accent trigger, matching Automa's
   * while-loop form.
   */
  variant?: 'summary' | 'button'
  children: ReactNode
}) {
  const { bt } = useEditorLocale()
  const [open, setOpen] = useState(false)
  const titleText = typeof summary === 'string' ? summary : undefined

  return (
    <div className="flex flex-col gap-2">
      {variant === 'button' ? (
        <button
          type="button"
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-strong"
          onClick={() => setOpen(true)}
        >
          <Pencil size={13} /> {bt(editLabel)}
        </button>
      ) : (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-sunken px-2.5 py-2">
          <span className="min-w-0 truncate text-xs text-muted" title={titleText}>
            {summary}
          </span>
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-panel px-2 py-1 text-xs text-ink hover:bg-hover"
            onClick={() => setOpen(true)}
          >
            <Pencil size={12} /> {bt(editLabel)}
          </button>
        </div>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={bt(title)}
        {...(icon ? { icon } : {})}
        {...(accent ? { accent } : {})}
        size={size}
      >
        {children}
      </Modal>
    </div>
  )
}
