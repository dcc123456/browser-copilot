/**
 * Top-of-panel notice with a manual close button.
 *
 * Every tab used to hand-roll the same `.banner` div, and only some of them let
 * the user clear it (by clicking the text). A shared control keeps the close
 * affordance identical everywhere and makes the dismissal explicit, while the
 * caller still owns the message state so a new notice is never swallowed by an
 * old dismissal.
 *
 * Styling stays on the existing `.banner` / `.banner-link` surface classes —
 * tests and the ErrorBoundary rely on them — with Tailwind for the new parts.
 *
 * @module sidepanel/components/Banner
 */

import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '../i18n'

export type BannerKind = 'ok' | 'error'

export default function Banner({
  kind,
  children,
  onClick,
  onDismiss,
  title,
  link = false,
}: {
  kind: BannerKind
  children: ReactNode
  /** Makes the whole notice activate (e.g. deep-link to History). */
  onClick?: () => void
  /** Shows the close button; the caller clears its own message state. */
  onDismiss?: () => void
  title?: string
  /** Adds the chevron + pointer affordance for a clickable notice. */
  link?: boolean
}) {
  const t = useT()

  return (
    <div
      className={`banner flex items-start gap-2${link ? ' banner-link' : ''}`}
      data-kind={kind}
      role={kind === 'error' ? 'alert' : 'status'}
      onClick={onClick}
      title={title}
    >
      {/* `banner-text` is the class existing tests read the message from. */}
      <span className="banner-text min-w-0 flex-1 break-words">{children}</span>
      {link && (
        <span className="banner-chevron" aria-hidden="true">
          ›
        </span>
      )}
      {onDismiss && (
        <button
          type="button"
          className="-mr-0.5 shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100"
          aria-label={t.bannerDismiss}
          title={t.bannerDismiss}
          onClick={(event) => {
            event.stopPropagation()
            onDismiss()
          }}
        >
          <X size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
