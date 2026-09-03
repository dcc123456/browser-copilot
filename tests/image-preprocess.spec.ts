import { describe, expect, it } from 'vitest'
import { computeUpscaleFactor, enhancePixels } from '../src/lib/image-preprocess'

/** Builds an RGBA buffer from `[r, g, b, a?]` tuples. */
function rgba(pixels: [number, number, number, number?][]): Uint8ClampedArray {
  const px = new Uint8ClampedArray(pixels.length * 4)
  pixels.forEach(([r, g, b, a], i) => {
    px[i * 4] = r
    px[i * 4 + 1] = g
    px[i * 4 + 2] = b
    px[i * 4 + 3] = a ?? 255
  })
  return px
}

describe('computeUpscaleFactor', () => {
  it('upscales small captcha-sized images 3x', () => {
    expect(computeUpscaleFactor(200, 60)).toBe(3)
    expect(computeUpscaleFactor(150, 150)).toBe(3)
  })

  it('keeps large screenshots at 1:1', () => {
    expect(computeUpscaleFactor(1920, 1080)).toBe(1)
    expect(computeUpscaleFactor(800, 300)).toBe(1)
    expect(computeUpscaleFactor(1200, 600)).toBe(1)
  })

  it('caps the upscaled side at maxUpscaledSide', () => {
    // 1000px * 3 = 3000 > 2400 → clamped to 2400/1000.
    expect(computeUpscaleFactor(1000, 500, { upscaleBelowSide: 2000 })).toBeCloseTo(2.4, 5)
  })

  it('returns 1 for degenerate sizes', () => {
    expect(computeUpscaleFactor(0, 0)).toBe(1)
    expect(computeUpscaleFactor(-10, 50)).toBe(1)
  })

  it('respects a custom upscale factor', () => {
    expect(computeUpscaleFactor(100, 40, { upscaleFactor: 2 })).toBe(2)
  })
})

describe('enhancePixels', () => {
  it('near-binarizes faint gray text on a light background', () => {
    // One faint glyph pixel (120) on a near-white background (250).
    const px = rgba([
      [250, 250, 250],
      [250, 250, 250],
      [120, 120, 120],
      [250, 250, 250],
    ])
    enhancePixels(px, 4, 1)
    expect(px[8]).toBe(0) // glyph → ink black
    expect(px[0]).toBe(255) // background → white
  })

  it('keeps pure black/white images black/white', () => {
    const px = rgba([
      [0, 0, 0],
      [255, 255, 255],
    ])
    enhancePixels(px, 2, 1)
    expect(px[0]).toBe(0)
    expect(px[4]).toBe(255)
  })

  it('grayscales colour pixels by luminance', () => {
    // Pure red (luma ≈ 76) next to pure white.
    const px = rgba([
      [255, 0, 0],
      [255, 255, 255],
    ])
    enhancePixels(px, 2, 1)
    expect(px[0]).toBe(px[1])
    expect(px[1]).toBe(px[2])
    // Red is far darker than the clipped white → stretched to near black.
    expect(px[0]).toBeLessThan(80)
  })

  it('keeps a midtone gradient monotonic', () => {
    const px = rgba([
      [100, 100, 100],
      [140, 140, 140],
      [180, 180, 180],
    ])
    enhancePixels(px, 3, 1)
    const v = (i: number): number => px[i * 4]!
    expect(v(0)).toBeLessThan(v(1))
    expect(v(1)).toBeLessThan(v(2))
  })

  it('leaves a uniform mid-gray image unchanged', () => {
    const px = rgba([
      [128, 128, 128],
      [128, 128, 128],
    ])
    enhancePixels(px, 2, 1)
    expect(px[0]).toBe(128)
  })

  it('composites semi-transparent ink onto white and flattens alpha', () => {
    const px = rgba([
      [0, 0, 0, 128], // semi-transparent black ≈ mid-gray over white
      [255, 255, 255, 0], // fully transparent → white
    ])
    enhancePixels(px, 2, 1)
    expect(px[0]).toBe(0) // dark ink, enhanced
    expect(px[3]).toBe(255) // alpha flattened
    expect(px[4]).toBe(255) // transparent → white
    expect(px[7]).toBe(255)
  })

  it('keeps light ink on a transparent background visible (black composite + flip)', () => {
    // White glyphs on a transparent background — composited onto white they
    // would vanish entirely (the washed-out captcha failure mode).
    const W: [number, number, number, number] = [255, 255, 255, 255]
    const B: [number, number, number, number] = [0, 0, 0, 0]
    const px = rgba([B, B, B, B, W, W, B, B]) // 2x4: white glyph row on transparent bg
    enhancePixels(px, 2, 4)
    expect(px[3]).toBe(255) // flattened
    expect(px[0]).toBe(255) // background → white
    expect(px[16]).toBe(0) // glyph ink → black (polarity normalized)
  })

  it('inverts an opaque dark-background image to dark-on-white', () => {
    const K: [number, number, number, number] = [10, 10, 10, 255]
    const G: [number, number, number, number] = [240, 240, 240, 255]
    const px = rgba([K, K, K, K, G, G, K, K]) // 2x4: light glyph on near-black bg
    enhancePixels(px, 2, 4)
    expect(px[0]).toBe(255) // dark background → white
    expect(px[16]).toBe(0) // light glyph → black
  })

  it('handles an empty buffer without throwing', () => {
    expect(() => enhancePixels(new Uint8ClampedArray(0), 0, 0)).not.toThrow()
  })
})
