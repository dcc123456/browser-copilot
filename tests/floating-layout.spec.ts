import { describe, expect, it } from 'vitest'
import {
  avoidOverlap,
  boxDistance,
  boxesConflict,
  clampBox,
  LAYOUT_GAP,
  LAYOUT_MARGIN,
  type Box,
} from '../src/lib/floating-layout'

const viewport = { width: 1_200, height: 800 }
const box = (left: number, top: number): Box => ({ left, top, width: 40, height: 40 })

describe('floating layout', () => {
  it('keeps a box inside the viewport margins', () => {
    expect(clampBox(box(-50, 900), viewport)).toEqual({
      ...box(0, 0),
      left: LAYOUT_MARGIN,
      top: 800 - 40 - LAYOUT_MARGIN,
    })
  })

  it('a box that already clears stays exactly where it was dropped', () => {
    const dragged = box(200, 200)
    expect(avoidOverlap(dragged, box(600, 600), viewport)).toEqual(dragged)
  })

  it('moves only the dragged control, clearing the gap', () => {
    const other = box(600, 600)
    const dragged = box(610, 610)
    const placed = avoidOverlap(dragged, other, viewport)
    expect(boxesConflict(placed, other)).toBe(false)
    expect(boxDistance(placed, other)).toBeGreaterThanOrEqual(LAYOUT_GAP)
    // The other control is untouched by construction; the dragged one moved.
    expect(placed).not.toEqual(dragged)
  })

  it('clamps the result inside the viewport too', () => {
    const placed = avoidOverlap(box(1_190, 10), box(1_150, 0), viewport)
    expect(placed.left).toBeGreaterThanOrEqual(LAYOUT_MARGIN)
    expect(placed.left + placed.width).toBeLessThanOrEqual(viewport.width - LAYOUT_MARGIN)
  })

  it('chooses the smallest slide among the four directions', () => {
    // Dragging exactly onto the other box: the nearest clearing slide is one
    // gap beyond an edge, not the far corner.
    const other = box(500, 400)
    const placed = avoidOverlap(box(500, 400), other, viewport)
    expect(Math.hypot(placed.left - 500, placed.top - 400)).toBeLessThan(100)
  })
})
