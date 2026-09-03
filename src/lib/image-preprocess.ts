/**
 * Pixel-level preprocessing for the image-recognition pipeline.
 *
 * Tesseract.js (and, to a lesser degree, vision models) reads small text far
 * better when the glyphs are ~30-50px tall and the ink/background separation is
 * strong. Captchas captured from a page are often 15-25px tall with faint or
 * coloured noise, so before recognition we:
 *
 * 1. Upscale small images ({@link computeUpscaleFactor}) — 3x turns 15px text
 *    into 45px; large screenshots are left alone so payloads stay small.
 * 2. Enhance contrast ({@link enhancePixels}) — grayscale, a percentile-based
 *    contrast stretch (robust to noise outliers that break min/max stretching)
 *    and a final contrast boost around mid-gray.
 *
 * Everything here is pure array math with no DOM dependency, so it is
 * unit-testable under Node; the canvas plumbing that feeds it lives in
 * {@link ./vision.ts | lib/vision}.
 *
 * @module lib/image-preprocess
 */

/** Knobs for {@link computeUpscaleFactor}. All sides are in pixels. */
export interface UpscaleOptions {
  /** Images whose largest side is >= this are never upscaled. Default 800. */
  upscaleBelowSide?: number
  /** Scale multiplier applied to small images. Default 3. */
  upscaleFactor?: number
  /** Hard cap on the upscaled largest side. Default 2400. */
  maxUpscaledSide?: number
}

/** Knobs for {@link enhancePixels}. */
export interface EnhanceOptions {
  /**
   * Fraction of the darkest and brightest pixels clipped away before the
   * contrast stretch, so a few noise specks cannot skew the range. Default 0.01.
   */
  clipFraction?: number
  /** Extra contrast around mid-gray applied after the stretch. Default 1.5. */
  contrast?: number
}

/**
 * Scale factor to apply to an image before recognition, or 1 to keep the
 * original size. Small captures (captchas) are blown up by `upscaleFactor`
 * because OCR accuracy collapses on short glyphs; anything already large
 * (full-page screenshots) is returned unchanged so payloads do not balloon.
 * The result is never below 1 and keeps the upscaled largest side within
 * `maxUpscaledSide`.
 */
export function computeUpscaleFactor(width: number, height: number, opts: UpscaleOptions = {}): number {
  const upscaleBelowSide = opts.upscaleBelowSide ?? 800
  const factor = opts.upscaleFactor ?? 3
  const maxUpscaledSide = opts.maxUpscaledSide ?? 2400

  const largest = Math.max(width, height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1
  if (largest >= upscaleBelowSide) return 1

  const target = Math.min(largest * factor, maxUpscaledSide)
  const effective = target / largest
  // A marginal upscale buys nothing and only costs bytes.
  return effective <= 1.05 ? 1 : effective
}

/**
 * In-place grayscale + contrast enhancement of an RGBA pixel buffer (as
 * returned by `getImageData`), normalized to dark-ink-on-white:
 *
 * 1. Convert to relative-luminance grayscale (BT.601 coefficients).
 * 2. Transparent pixels are composited onto a background chosen from the ink's
 *    polarity — white for dark ink, black for light ink (a white-on-transparent
 *    captcha composited onto white would be washed out to a blank image).
 * 3. Find the [lo, hi] luminance window covering all but `clipFraction` of the
 *    darkest and brightest pixels, then stretch that window to [0, 255].
 * 4. Apply a final contrast curve around mid-gray; on a typical captcha the
 *    combined slope is ~2x, which near-binarizes faint ink without fully
 *    destroying anti-aliased edges.
 * 5. Normalize polarity: OCR engines and vision models both read dark text on
 *    a light background best, so a dark border (dark-mode page, white-on-black
 *    captcha) is inverted.
 *
 * The alpha channel is flattened to fully opaque. Runs in O(n).
 */
export function enhancePixels(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  opts: EnhanceOptions = {},
): void {
  const clipFraction = Math.min(0.45, Math.max(0, opts.clipFraction ?? 0.01))
  const contrast = opts.contrast ?? 1.5
  const n = px.length >> 2
  if (n === 0) return

  // Pass 1: grayscale + alpha statistics.
  const hist = new Uint32Array(256)
  const gray = new Uint8ClampedArray(n)
  let hasAlpha = false
  let opaqueCount = 0
  let opaqueLumaSum = 0
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    // Math.round, not |0: the float sum for e.g. white is 254.999…, and
    // truncating would skew every histogram bucket by one level.
    const l = Math.round(0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!)
    gray[j] = l
    hist[l] = (hist[l] ?? 0) + 1
    const a = px[i + 3]!
    if (a < 255) hasAlpha = true
    if (a >= 128) {
      opaqueCount++
      opaqueLumaSum += l
    }
  }

  // Transparent background → composite onto the polarity that keeps the ink
  // visible: light ink gets a black background, dark ink a white one.
  if (hasAlpha) {
    const lightInk = opaqueCount > 0 && opaqueLumaSum / opaqueCount > 128
    const bg = lightInk ? 0 : 255
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      const a = px[i + 3]! / 255
      const out = gray[j]! * a + bg * (1 - a)
      px[i] = out
      px[i + 1] = out
      px[i + 2] = out
      px[i + 3] = 255
    }
    // Compositing changed every luma value — rebuild gray + histogram.
    hist.fill(0)
    for (let j = 0; j < n; j++) {
      gray[j] = px[j * 4]!
      hist[gray[j]!] = (hist[gray[j]!] ?? 0) + 1
    }
  }

  // Percentile window [lo, hi] that skips the clipped tails. A bucket is
  // consumed only while the cumulative skip count stays strictly below the
  // target — otherwise tiny images (where every bucket count qualifies) would
  // collapse the window onto a wrong bucket.
  const clipCount = Math.max(1, Math.floor(n * clipFraction))
  let lo = 0
  let skipped = 0
  while (lo < 255 && skipped + hist[lo]! < clipCount) {
    skipped += hist[lo]!
    lo++
  }
  let hi = 255
  skipped = 0
  while (hi > 0 && skipped + hist[hi]! < clipCount) {
    skipped += hist[hi]!
    hi--
  }
  // A flat histogram (hi <= lo) has no contrast to stretch — keep the identity
  // mapping so a uniform image does not get smeared to black.
  if (hi <= lo) {
    lo = 0
    hi = 255
  }
  const range = hi - lo
  const scale = range > 0 ? 255 / range : 1

  // Stretch, then contrast around mid-gray, then write back.
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    let v = (gray[j]! - lo) * scale
    v = 128 + (v - 128) * contrast
    px[i] = v
    px[i + 1] = v
    px[i + 2] = v
  }

  // Polarity normalization: OCR engines and vision models read dark ink on a
  // light background best. A dark border means the background is dark
  // (dark-mode page, white-on-black captcha) → invert. The threshold is
  // conservative so noisy or tiny images are left alone.
  const borderDepth = Math.min(2, Math.floor(Math.min(width, height) / 2))
  if (borderDepth >= 1) {
    let borderSum = 0
    let borderCount = 0
    const sample = (x: number, y: number): void => {
      borderSum += px[(y * width + x) * 4]!
      borderCount++
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x < borderDepth || x >= width - borderDepth || y < borderDepth || y >= height - borderDepth) {
          sample(x, y)
        }
      }
    }
    if (borderCount > 0 && borderSum / borderCount < 96) {
      for (let i = 0; i < px.length; i += 4) {
        px[i] = 255 - px[i]!
        px[i + 1] = 255 - px[i + 1]!
        px[i + 2] = 255 - px[i + 2]!
      }
    }
  }
}
