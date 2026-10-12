/**
 * Deep-link row highlight for the side panel's lists: flash a row for a moment,
 * then scroll it into view once it has rendered. The flash style stays with the
 * list that owns it (`task-item-saved`); this decides only which row is lit.
 *
 * Transport is a `window` CustomEvent with `{ id }` detail, the shape
 * `bc:open-history` and `bc:open-conversation` already use.
 *
 * @module sidepanel/hooks/useRowHighlight
 */
import { useCallback, useEffect, useState } from 'react'

export interface RowHighlight {
  /** Id of the row to light up; `null` while nothing is flashing. */
  highlightedId: string | null
  /** Light the row and scroll it into view. */
  flash: (id: string) => void
}

/** How long a flashed row stays lit, matching the task list's save feedback. */
const FLASH_MS = 1800

/** Grace for the row to render before it is scrolled to. */
const SCROLL_DELAY_MS = 60

export function useRowHighlight(event: string, attribute: string): RowHighlight {
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  const flash = useCallback((id: string): void => setHighlightedId(id), [])

  // Another tab asked for this row; App has already flipped the active tab.
  useEffect(() => {
    const handler = (incoming: Event): void => {
      const id = (incoming as CustomEvent<{ id?: string }>).detail?.id
      if (id) setHighlightedId(id)
    }
    window.addEventListener(event, handler)
    return () => window.removeEventListener(event, handler)
  }, [event])

  useEffect(() => {
    if (!highlightedId) return
    const timer = setTimeout(() => setHighlightedId(null), FLASH_MS)
    const scrollTimer = setTimeout(() => {
      document
        .querySelector(`[${attribute}="${highlightedId}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, SCROLL_DELAY_MS)
    return () => {
      clearTimeout(timer)
      clearTimeout(scrollTimer)
    }
  }, [highlightedId, attribute])

  return { highlightedId, flash }
}
