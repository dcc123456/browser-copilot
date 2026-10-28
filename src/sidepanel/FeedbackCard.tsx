/**
 * Settings entry for feedback; the dialog itself holds all state.
 *
 * @module sidepanel/FeedbackCard
 */

import { useState } from 'react'
import { PRIMARY_BUTTON } from '../ui/button-styles'
import FeedbackDialog from './FeedbackDialog'
import { useT } from './i18n'

export default function FeedbackCard(): React.ReactElement {
  const t = useT()
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <div className="mb-2.5 rounded-[10px] border border-border bg-panel p-3">
      <span className="font-semibold">{t.feedbackTitle}</span>
      <p className="mt-1.5 mb-2.5 text-[11px] leading-relaxed text-muted">{t.feedbackIntro}</p>
      <button className={PRIMARY_BUTTON} onClick={() => setDialogOpen(true)} type="button">
        {t.feedbackOpen}
      </button>
      {dialogOpen && <FeedbackDialog onClose={() => setDialogOpen(false)} />}
    </div>
  )
}
