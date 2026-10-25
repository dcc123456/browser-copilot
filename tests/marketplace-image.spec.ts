import { describe, expect, it } from 'vitest'
import { compressImage, fitWithin } from '../src/lib/marketplace/image'
import { MAX_PUBLISH_IMAGE_BYTES } from '../src/lib/marketplace/types'

describe('fitWithin', () => {
  it('scales the longest edge down and keeps the ratio', () => {
    expect(fitWithin(4000, 2000, 1600)).toEqual({ width: 1600, height: 800 })
    expect(fitWithin(1000, 3000, 1600)).toEqual({ width: 533, height: 1600 })
  })

  it('never upscales small images', () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 })
  })

  it('keeps at least one pixel on the short edge', () => {
    expect(fitWithin(10000, 1, 100)).toEqual({ width: 100, height: 1 })
  })
})

describe('compressImage fallback', () => {
  it('returns a small image untouched when the browser cannot decode it', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    await expect(compressImage(blob)).resolves.toBe(blob)
  })

  it('refuses an undecodable image above the publish cap', async () => {
    const blob = new Blob([new Uint8Array(MAX_PUBLISH_IMAGE_BYTES + 1)], { type: 'image/png' })
    await expect(compressImage(blob)).rejects.toMatchObject({ code: 'invalid' })
  })
})
