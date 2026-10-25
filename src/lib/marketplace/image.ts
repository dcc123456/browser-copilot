/**
 * Client-side image normalisation for publishing.
 *
 * Workflow screenshots are PNG captures of a 4K screen; committing them as-is
 * would bloat the marketplace repo. Everything is re-encoded to WebP with a
 * 1600px long edge, then stepped down until it fits the publish size cap.
 *
 * `fitWithin` is separated from the canvas work so the arithmetic is testable
 * in Node, where `createImageBitmap`/`OffscreenCanvas` do not exist.
 *
 * @module lib/marketplace/image
 */

import { MAX_PUBLISH_IMAGE_BYTES, MarketplaceError } from './types'

const MAX_EDGE = 1600
const QUALITY_STEPS = [0.85, 0.7, 0.55]
const MAX_ROUNDS = 4

export interface ImageSize {
  width: number
  height: number
}

/** Scales `width × height` down to fit a square `max` edge, preserving ratio. */
export function fitWithin(width: number, height: number, max: number): ImageSize {
  const longest = Math.max(width, height)
  if (longest <= max || longest === 0) return { width, height }
  const scale = max / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * Re-encodes an image to WebP under {@link MAX_PUBLISH_IMAGE_BYTES}.
 *
 * Falls back to the original blob when the browser cannot decode it (older
 * engines, exotic formats): the publish path re-checks the byte size, so the
 * failure surfaces as a validation error rather than a broken commit.
 */
export async function compressImage(blob: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    if (blob.size > MAX_PUBLISH_IMAGE_BYTES) {
      throw new MarketplaceError('invalid', 'Each image must be 1 MB or smaller')
    }
    return blob
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    if (blob.size > MAX_PUBLISH_IMAGE_BYTES) {
      throw new MarketplaceError('invalid', 'Each image must be 1 MB or smaller')
    }
    return blob
  }

  try {
    let maxEdge = MAX_EDGE
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge)
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')
      if (!context) throw new MarketplaceError('invalid', 'Could not process the image')
      context.drawImage(bitmap, 0, 0, width, height)
      for (const quality of QUALITY_STEPS) {
        const encoded = await canvas.convertToBlob({ type: 'image/webp', quality })
        if (encoded.size <= MAX_PUBLISH_IMAGE_BYTES) return encoded
      }
      maxEdge = Math.max(640, Math.round(maxEdge * 0.7))
    }
  } finally {
    bitmap.close()
  }

  throw new MarketplaceError('invalid', 'Each image must be 1 MB or smaller')
}
