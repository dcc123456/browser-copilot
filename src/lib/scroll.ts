/**
 * Stick-to-bottom helper for the chat log.
 *
 * The chat log used to scroll to the very bottom on EVERY render delta, which
 * yanked the view back down whenever the user tried to scroll up during a
 * streaming answer. The fix is the standard stick-to-bottom pattern: auto-
 * follow only while the user is already at (or near) the bottom, and surface a
 * "jump to latest" affordance once they scroll away. This predicate decides
 * "near the bottom" — kept pure so the threshold semantics are unit-testable
 * (jsdom performs no real layout).
 */

/** Distance from the bottom (px) that still counts as "at the bottom". */
export const NEAR_BOTTOM_THRESHOLD_PX = 64

export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = NEAR_BOTTOM_THRESHOLD_PX,
): boolean {
  if (scrollHeight <= 0 || clientHeight <= 0) return true
  const distance = scrollHeight - clientHeight - scrollTop
  return distance <= threshold
}
