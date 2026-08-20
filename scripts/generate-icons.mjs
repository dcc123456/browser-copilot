/**
 * Generates the extension icons.
 *
 * Chrome needs raster PNGs for the toolbar, so the artwork is produced here
 * rather than committed as opaque binaries: the design stays reviewable as code,
 * and every size is regenerated consistently instead of being rescaled by hand.
 *
 * Design: a rounded square in the panel background colour, a page glyph with text
 * lines (what this assistant reads) and a small accent spark at the upper right
 * (the agent that reads it). Both read at 16px, which is the size that actually
 * matters for a pinned toolbar button.
 *
 * Run with: node scripts/generate-icons.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'public', 'icons')

const BG = [0x1c, 0x1f, 0x26]
const ACCENT = [0x5b, 0x8c, 0xff]
const FACE = [0xe6, 0xe8, 0xec]

/** Sizes Chrome asks for across the toolbar, management page, and store. */
const SIZES = [16, 32, 48, 128]

/** Straight-alpha pixel buffer helper. */
function createCanvas(size) {
  // RGBA, transparent by default so the rounded corners stay transparent.
  return { size, data: new Uint8Array(size * size * 4) }
}

function setPixel(canvas, x, y, [r, g, b], alpha) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return
  if (alpha <= 0) return

  const index = (y * canvas.size + x) * 4
  const existingAlpha = canvas.data[index + 3] / 255
  const incoming = Math.min(1, alpha)

  // Standard source-over compositing, so anti-aliased edges layer correctly.
  const outAlpha = incoming + existingAlpha * (1 - incoming)
  if (outAlpha <= 0) return

  for (let channel = 0; channel < 3; channel += 1) {
    const src = [r, g, b][channel]
    const dst = canvas.data[index + channel]
    canvas.data[index + channel] = Math.round(
      (src * incoming + dst * existingAlpha * (1 - incoming)) / outAlpha,
    )
  }
  canvas.data[index + 3] = Math.round(outAlpha * 255)
}

/**
 * Coverage of a pixel by a shape, sampled on a 4x4 grid.
 *
 * Supersampling rather than analytic coverage: at 16px the difference is
 * invisible, and this keeps each shape a simple inside/outside predicate.
 */
function coverage(x, y, inside) {
  const STEPS = 4
  let hits = 0
  for (let sy = 0; sy < STEPS; sy += 1) {
    for (let sx = 0; sx < STEPS; sx += 1) {
      const px = x + (sx + 0.5) / STEPS
      const py = y + (sy + 0.5) / STEPS
      if (inside(px, py)) hits += 1
    }
  }
  return hits / (STEPS * STEPS)
}

/**
 * Fills a shape, optionally restricted to a mask.
 *
 * The mask is used to repaint the background *inside* a cleared gap, so the gap
 * shows the icon's own backdrop rather than a hole through to the toolbar.
 */
function fill(canvas, colour, inside, mask) {
  for (let y = 0; y < canvas.size; y += 1) {
    for (let x = 0; x < canvas.size; x += 1) {
      const alpha = coverage(x, y, mask ? (px, py) => inside(px, py) && mask(px, py) : inside)
      if (alpha > 0) setPixel(canvas, x, y, colour, alpha)
    }
  }
}

/** Resets pixels inside a shape to fully transparent, ignoring what was there. */
function clear(canvas, inside) {
  for (let y = 0; y < canvas.size; y += 1) {
    for (let x = 0; x < canvas.size; x += 1) {
      if (coverage(x, y, inside) < 0.5) continue
      const index = (y * canvas.size + x) * 4
      canvas.data[index] = 0
      canvas.data[index + 1] = 0
      canvas.data[index + 2] = 0
      canvas.data[index + 3] = 0
    }
  }
}

/** Rounded-square predicate, matching the panel's 8px card radius in spirit. */
function roundedSquare(size) {
  const radius = size * 0.22
  const min = size * 0.04
  const max = size - min
  return (x, y) => {
    if (x < min || y < min || x > max || y > max) return false
    const innerMinX = min + radius
    const innerMaxX = max - radius
    const innerMinY = min + radius
    const innerMaxY = max - radius
    const cx = Math.min(Math.max(x, innerMinX), innerMaxX)
    const cy = Math.min(Math.max(y, innerMinY), innerMaxY)
    // Inside the straight edges, or within the corner radius.
    if (x >= innerMinX && x <= innerMaxX) return true
    if (y >= innerMinY && y <= innerMaxY) return true
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
  }
}

/** Axis-aligned rectangle with rounded corners, used for the page glyph. */
function roundedRect(left, top, right, bottom, radius) {
  return (x, y) => {
    if (x < left || x > right || y < top || y > bottom) return false
    const cx = Math.min(Math.max(x, left + radius), right - radius)
    const cy = Math.min(Math.max(y, top + radius), bottom - radius)
    if (x >= left + radius && x <= right - radius) return true
    if (y >= top + radius && y <= bottom - radius) return true
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
  }
}

/** Thick line segment as a capsule, so text lines keep clean ends at small sizes. */
function segment(x1, y1, x2, y2, halfWidth) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy
  return (x, y) => {
    if (lengthSquared === 0) return (x - x1) ** 2 + (y - y1) ** 2 <= halfWidth ** 2
    let t = ((x - x1) * dx + (y - y1) * dy) / lengthSquared
    t = Math.min(1, Math.max(0, t))
    const px = x1 + t * dx
    const py = y1 + t * dy
    return (x - px) ** 2 + (y - py) ** 2 <= halfWidth ** 2
  }
}

function disc(cx, cy, radius) {
  return (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
}

function drawIcon(size) {
  const canvas = createCanvas(size)
  const s = (fraction) => fraction * size

  fill(canvas, BG, roundedSquare(size))

  /**
   * Small sizes get a deliberately different layout, not a scaled-down one.
   *
   * At 16px a proportionally-scaled page outline lands near one device pixel and
   * breaks into dashes, and three proportional text lines merge into a grey
   * block. So 16px draws a solid page with two thick lines instead of an outline
   * with three thin ones. Verified by rendering each size, not assumed.
   */
  const tiny = size <= 16
  const small = size <= 32

  // Page glyph, nudged down-left to leave room for the spark.
  const left = tiny ? s(0.16) : s(0.2)
  const right = tiny ? s(0.66) : s(0.68)
  const top = tiny ? s(0.28) : s(0.26)
  const bottom = tiny ? s(0.86) : s(0.82)
  const pageRadius = size * (tiny ? 0.06 : 0.07)

  if (tiny) {
    // Solid page: an outline this small cannot hold a visible border and an
    // interior at the same time.
    fill(canvas, FACE, roundedRect(left, top, right, bottom, pageRadius))
    // Lines are punched out of the page in the background colour, which stays
    // legible where a lighter-on-light stroke would not.
    const lineWidth = Math.max(0.9, size * 0.055)
    for (const fraction of [0.45, 0.65]) {
      fill(
        canvas,
        BG,
        segment(left + s(0.07), top + (bottom - top) * fraction, right - s(0.07), top + (bottom - top) * fraction, lineWidth),
      )
    }
  } else {
    // Outlined page: fill, then clear the interior and repaint the backdrop, so
    // the border reads as a stroke rather than a filled block.
    const stroke = Math.max(1.5, size * (small ? 0.075 : 0.055))
    fill(canvas, FACE, roundedRect(left, top, right, bottom, pageRadius))
    const inner = roundedRect(
      left + stroke,
      top + stroke,
      right - stroke,
      bottom - stroke,
      Math.max(0, pageRadius - stroke * 0.5),
    )
    clear(canvas, inner)
    fill(canvas, BG, roundedSquare(size), inner)

    // Text lines. The last one is short, which is what makes the glyph read as
    // prose rather than as a table.
    const lineWidth = Math.max(1, size * (small ? 0.05 : 0.04))
    const lineLeft = left + stroke + size * 0.06
    const lineRight = right - stroke - size * 0.06
    const rows = [0.32, 0.52, 0.72]
    rows.forEach((fraction, index) => {
      const y = top + (bottom - top) * fraction
      const end = index === rows.length - 1 ? lineLeft + (lineRight - lineLeft) * 0.55 : lineRight
      fill(canvas, FACE, segment(lineLeft, y, end, y, lineWidth))
    })
  }

  // Accent spark: a diamond, which stays sharper than a star at small sizes.
  const sparkX = tiny ? s(0.79) : s(0.79)
  const sparkY = tiny ? s(0.21) : s(0.24)
  const sparkR = tiny ? s(0.17) : s(0.16)

  // Punch a transparent gap so the spark never merges with the page glyph.
  const gap = sparkR * (tiny ? 1.5 : 1.4)
  clear(canvas, disc(sparkX, sparkY, gap))
  fill(canvas, BG, roundedSquare(size), disc(sparkX, sparkY, gap))

  fill(canvas, ACCENT, (x, y) => {
    const dx = Math.abs(x - sparkX) / sparkR
    const dy = Math.abs(y - sparkY) / sparkR
    return dx + dy <= 1
  })

  return canvas
}

// --- Minimal PNG encoder -----------------------------------------------------
// Only what these icons need: 8-bit RGBA, no interlacing. Avoids adding an image
// dependency for four small files.

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

function encodePng(canvas) {
  const { size, data } = canvas

  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  header[10] = 0
  header[11] = 0
  header[12] = 0

  // Each scanline is prefixed with its filter type (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < size * 4; x += 1) {
      raw[rowStart + 1 + x] = data[y * size * 4 + x]
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT_DIR, { recursive: true })
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon-${size}.png`)
  writeFileSync(file, encodePng(drawIcon(size)))
  console.log(`wrote ${file}`)
}
