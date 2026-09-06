/**
 * Generates the extension icons.
 *
 * Chrome needs raster PNGs for the toolbar, so the artwork is produced here
 * rather than committed as opaque binaries: the design stays reviewable as code,
 * and every size is regenerated consistently instead of being rescaled by hand.
 *
 * Design: lucide's `bot` icon (https://lucide.dev, ISC license) rasterized from
 * its official 24x24 geometry — the same path data the `lucide-react`
 * components render — drawn with lucide's stroke width and round caps onto a
 * rounded square in the panel background colour. The eyes use the accent
 * colour so the glyph carries the brand spark the previous hand-drawn page
 * artwork had, and everything still reads at 16px, the size that actually
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

// --- lucide `bot` geometry (24x24 viewBox, stroke-based, fill="none") --------
// https://lucide.dev/icons/bot — rounded-rect body, two eye dots, an antenna
// line, and a head circle. Reproduced exactly; do not hand-adjust coordinates.
const BOT = {
  /** <rect width="18" height="10" x="3" y="11" rx="2"/> */
  body: { x: 3, y: 11, w: 18, h: 10, rx: 2 },
  /** <circle cx="12" cy="5" r="2"/> — antenna tip */
  antennaDot: { cx: 12, cy: 5, r: 2 },
  /** <path d="M12 7v4"/> — antenna stem */
  antennaStem: { x1: 12, y1: 7, x2: 12, y2: 11 },
  /** <line x1="8" x2="8" y1="16" y2="16"/> + <line x1="16" .../> — eyes */
  eyes: [
    { x: 8, y: 16 },
    { x: 16, y: 16 },
  ],
}

/** Lucide's stroke spec: stroke-width 2 in the 24 viewBox, round caps/joins. */
const VIEW = 24
const STROKE = 2

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
 * invisible, and this keeps each shape a simple distance predicate.
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

/** Fills a shape. */
function fill(canvas, colour, inside) {
  for (let y = 0; y < canvas.size; y += 1) {
    for (let x = 0; x < canvas.size; x += 1) {
      const alpha = coverage(x, y, inside)
      if (alpha > 0) setPixel(canvas, x, y, colour, alpha)
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

// --- lucide stroke rasterization ---------------------------------------------
// Lucide icons are stroked paths, so each shape is drawn as a band around its
// centerline: the set of points within STROKE/2 of the outline, with round
// caps and joins exactly as the SVG renderer produces them.

/** Signed distance to a rounded rectangle's boundary (negative inside). */
function roundedRectSDF(px, py, rect) {
  const halfW = rect.w / 2
  const halfH = rect.h / 2
  const cx = rect.x + halfW
  const cy = rect.y + halfH
  const qx = Math.abs(px - cx) - (halfW - rect.rx)
  const qy = Math.abs(py - cy) - (halfH - rect.rx)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - rect.rx
}

/** Distance from a point to a segment, with the point repeated for round caps. */
function segmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared
  t = Math.min(1, Math.max(0, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function drawIcon(size) {
  const canvas = createCanvas(size)

  // The 24x24 lucide viewBox is scaled into the canvas with a margin so the
  // glyph clears the rounded-square border on every size.
  const CONTENT = size <= 16 ? 0.82 : 0.78
  const scale = (size * CONTENT) / VIEW
  const offset = (size - VIEW * scale) / 2
  const toCanvas = (v) => offset + v * scale
  // Lucide's 2/24 stroke lands near one device pixel at 16px, where it breaks
  // into dashes and the eye dots vanish entirely — the same failure mode the
  // previous artwork special-cased. Clamp the stroke so the glyph stays whole;
  // at every larger size this is a no-op.
  const halfStroke = Math.max((STROKE * scale) / 2, size <= 16 ? 0.72 : 0.55)

  fill(canvas, BG, roundedSquare(size))

  const body = {
    x: toCanvas(BOT.body.x),
    y: toCanvas(BOT.body.y),
    w: BOT.body.w * scale,
    h: BOT.body.h * scale,
    rx: BOT.body.rx * scale,
  }

  // Stroked body: points within halfStroke of the rounded-rect boundary.
  fill(canvas, FACE, (px, py) => Math.abs(roundedRectSDF(px, py, body)) <= halfStroke)

  // Antenna: stroked tip circle + stroked stem segment.
  const tip = {
    cx: toCanvas(BOT.antennaDot.cx),
    cy: toCanvas(BOT.antennaDot.cy),
    r: BOT.antennaDot.r * scale,
  }
  fill(
    canvas,
    FACE,
    (px, py) => Math.abs(Math.hypot(px - tip.cx, py - tip.cy) - tip.r) <= halfStroke,
  )
  fill(canvas, FACE, (px, py) => {
    const d = segmentDistance(
      px,
      py,
      toCanvas(BOT.antennaStem.x1),
      toCanvas(BOT.antennaStem.y1),
      toCanvas(BOT.antennaStem.x2),
      toCanvas(BOT.antennaStem.y2),
    )
    return d <= halfStroke
  })

  // Eyes: zero-length lucide <line>s render as round-cap dots; accent coloured.
  for (const eye of BOT.eyes) {
    const ex = toCanvas(eye.x)
    const ey = toCanvas(eye.y)
    const eyeR = size <= 16 ? Math.max(halfStroke, 0.95) : halfStroke
    fill(canvas, ACCENT, (px, py) => Math.hypot(px - ex, py - ey) <= eyeR)
  }

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
