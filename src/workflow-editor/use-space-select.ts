/**
 * Space-key state for the canvas box-select gesture.
 *
 * React Flow matches its selection key inside `useKeyPress`, and in this app a
 * TRUSTED Space never reaches that window-level handler (see
 * `specs/2026-10-16-canvas-box-select-design.md` for the probe evidence), while
 * Shift does. So we watch Space ourselves — the same window channel that always
 * sees it — and feed the result into `selectionOnDrag`, which React Flow honours
 * without any key matching. Release is unconditional: focus can move into a text
 * field while the key is held, and a keyup we ignored would leave the canvas
 * locked in box-select mode with no way out.
 *
 * @module workflow-editor/use-space-select
 */
import { useEffect, useState } from 'react'

/**
 * Whether a keyboard event landed in something the user is TYPING into. Both
 * consumers ask the same question for the same reason: a gesture owned by a text
 * field (a typed space, that field's own Ctrl+Z) must never reach the canvas.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return (
    !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true)
  )
}

/** True while the user holds Space outside a text field. */
export function useSpaceSelect(): boolean {
  const [held, setHeld] = useState(false)

  useEffect(() => {
    const onDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !event.repeat && !isEditableTarget(event.target)) setHeld(true)
    }
    const onUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setHeld(false)
    }
    // Same reset the flow applies to its own key trackers: a blurred window or an
    // opened context menu swallows the keyup, so the gesture has to end here.
    const reset = () => setHeld(false)

    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', reset)
    window.addEventListener('contextmenu', reset)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', reset)
      window.removeEventListener('contextmenu', reset)
    }
  }, [])

  return held
}
