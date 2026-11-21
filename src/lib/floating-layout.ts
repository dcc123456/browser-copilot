/**
 * Geometry for the two independent floating controls (the minimized icon and
 * the element-picker crosshair).
 *
 * They share one persisted record but never share a box: whichever control the
 * user dragged keeps its drop point, and the OTHER one yields when the two come
 * closer than `gap`. Pure and DOM-free so the avoidance rule is testable
 * without a browser.
 *
 * @module lib/floating-layout
 */

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
}

/** Inset every control keeps from the viewport edge. */
export const LAYOUT_MARGIN = 16
/** Minimum clear distance between the two controls. */
export const LAYOUT_GAP = 8

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max))

/** Keeps a box fully inside the viewport with the standard margin. */
export function clampBox(box: Box, viewport: Viewport, margin = LAYOUT_MARGIN): Box {
  return {
    ...box,
    left: clamp(box.left, margin, viewport.width - box.width - margin),
    top: clamp(box.top, margin, viewport.height - box.height - margin),
  }
}

/** Shortest distance between two boxes (0 when they intersect). */
export function boxDistance(first: Box, second: Box): number {
  const dx = Math.max(
    0,
    Math.max(second.left - (first.left + first.width), first.left - (second.left + second.width)),
  )
  const dy = Math.max(
    0,
    Math.max(second.top - (first.top + first.height), first.top - (second.top + second.height)),
  )
  return Math.hypot(dx, dy)
}

/** Whether the two controls are too close (overlapping or under `gap`). */
export function boxesConflict(first: Box, second: Box, gap = LAYOUT_GAP): boolean {
  return boxDistance(first, second) < gap
}

/**
 * Places `dragged` so it clears `other` by at least `gap`, keeping `dragged`
 * where the user put it whenever that already clears.
 *
 * The dragged control never moves the other one: it tries the four one-axis
 * slides (up, down, left, right) and keeps the smallest displacement that fits
 * the viewport. When no slide fits (a viewport too small for both), it parks at
 * the corner farthest from `other`; both boxes stay inside the viewport.
 */
export function avoidOverlap(
  dragged: Box,
  other: Box,
  viewport: Viewport,
  gap = LAYOUT_GAP,
  margin = LAYOUT_MARGIN,
): Box {
  const base = clampBox(dragged, viewport, margin)
  if (!boxesConflict(base, other, gap)) return base

  const candidates: Box[] = [
    { ...base, top: other.top - base.height - gap },
    { ...base, top: other.top + other.height + gap },
    { ...base, left: other.left - base.width - gap },
    { ...base, left: other.left + other.width + gap },
  ].map((candidate) => clampBox(candidate, viewport, margin))

  let best: Box | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    if (boxesConflict(candidate, other, gap)) continue
    const moved = Math.hypot(candidate.left - base.left, candidate.top - base.top)
    if (moved < bestDistance) {
      best = candidate
      bestDistance = moved
    }
  }
  if (best) return best

  // No slide clears: the two cannot both fit at this size. Park the dragged
  // control at the viewport corner farthest from `other`, which keeps both
  // visible and minimises the overlap.
  const corners: Box[] = [
    { ...base, left: margin, top: margin },
    { ...base, left: viewport.width - base.width - margin, top: margin },
    { ...base, left: margin, top: viewport.height - base.height - margin },
    {
      ...base,
      left: viewport.width - base.width - margin,
      top: viewport.height - base.height - margin,
    },
  ].map((candidate) => clampBox(candidate, viewport, margin))
  return corners.reduce((far, candidate) =>
    boxDistance(candidate, other) > boxDistance(far, other) ? candidate : far,
  )
}
