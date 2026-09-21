import { describe, expect, it } from 'vitest'
import { isNearBottom, NEAR_BOTTOM_THRESHOLD_PX } from '../src/lib/scroll'

/**
 * The chat log follows the newest output only while the user is already at the
 * bottom; `isNearBottom` decides that. jsdom performs no real layout, so the
 * semantics are pinned here arithmetically instead of through the component.
 */
describe('isNearBottom', () => {
  const CLIENT = 600

  it('counts a view pinned to the bottom as near', () => {
    expect(isNearBottom(2400, 3000, CLIENT)).toBe(true)
  })

  it('tolerates sub-threshold drift from the bottom', () => {
    // One pixel beyond the threshold stays "near" at the boundary itself.
    expect(isNearBottom(2400 - NEAR_BOTTOM_THRESHOLD_PX, 3000, CLIENT)).toBe(true)
  })

  it('stops following once the user scrolled beyond the threshold', () => {
    expect(isNearBottom(2400 - NEAR_BOTTOM_THRESHOLD_PX - 1, 3000, CLIENT)).toBe(false)
    expect(isNearBottom(0, 3000, CLIENT)).toBe(false)
  })

  it('treats an unmeasured container (zero sizes) as at the bottom', () => {
    // First paint: no layout yet — follow the output rather than never scroll.
    expect(isNearBottom(0, 0, 0)).toBe(true)
    expect(isNearBottom(0, 0, CLIENT)).toBe(true)
  })

  it('handles a container with no scrollable overflow as at the bottom', () => {
    expect(isNearBottom(0, CLIENT, CLIENT)).toBe(true)
  })

  it('honors a custom threshold', () => {
    expect(isNearBottom(2400 - 10, 3000, CLIENT, 10)).toBe(true)
    expect(isNearBottom(2400 - 11, 3000, CLIENT, 10)).toBe(false)
  })
})
