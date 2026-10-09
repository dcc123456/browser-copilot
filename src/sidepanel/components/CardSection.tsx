/**
 * A collapsible detail group for the end-of-turn cards.
 *
 * The header (title, row count, severity of what hides below) always stays
 * visible while the rows themselves fold away: the workflow save card carried a
 * dozen flat groups and buried its own actions under them. Details are collapsed
 * by default, so a dense card reads as a short list of categories first.
 *
 * Tailwind semantic tokens only (light + dark).
 *
 * @module sidepanel/components/CardSection
 */
import { useState, type ReactNode } from 'react'
import { ChevronRight, TriangleAlert } from 'lucide-react'
import { useT } from '../i18n'

/** What the collapsed rows are: nothing alarming, a warning, or an error. */
export type CardSectionTone = 'plain' | 'warn' | 'err'

export interface CardSectionProps {
  title: string
  /** Rows hidden behind the header. Omitted or 0 renders no count. */
  count?: number
  tone?: CardSectionTone
  children: ReactNode
}

export function CardSection({
  title,
  count = 0,
  tone = 'plain',
  children,
}: CardSectionProps): ReactNode {
  const t = useT()
  const [open, setOpen] = useState(false)
  // Nothing behind the header means no header: the card shrinks instead of
  // showing three empty groups.
  if (count === 0) return null
  return (
    <details
      className="rounded-lg border border-border"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium text-ink [&::-webkit-details-marker]:hidden">
        {tone === 'err' ? (
          <TriangleAlert className="h-3.5 w-3.5 flex-none text-err" aria-hidden />
        ) : tone === 'warn' ? (
          <TriangleAlert className="h-3.5 w-3.5 flex-none text-warn" aria-hidden />
        ) : null}
        <span>{title}</span>
        {count > 0 ? (
          <span className="text-[11px] font-normal text-muted">
            {t.chatWorkflowCardItemCount({ count })}
          </span>
        ) : null}
        <ChevronRight
          className={`ml-auto h-3 w-3 flex-none text-muted transition-transform duration-150 ${
            open ? 'rotate-90' : ''
          }`}
          aria-hidden
        />
      </summary>
      <div className="flex flex-col gap-1.5 border-t border-border px-2.5 pb-2 pt-1.5">
        {children}
      </div>
    </details>
  )
}
