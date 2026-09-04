/**
 * Offscreen document backing the `clipboard` workflow block and local OCR.
 *
 * Two jobs run here because both need a durable page context the service worker
 * does not have:
 * - `navigator.clipboard.readText()` requires a focused document with the
 *   `clipboardRead` permission. This page serves the clipboard block without
 *   disturbing the tab the user is looking at (`clip-get` / `clip-set`).
 * - Local OCR (Tesseract.js) needs a real document + a worker to compile the
 *   packaged WebAssembly core, so the `recognize_image` tool can read text
 *   offline without an image model (`ocr-image`).
 *
 * Both run in the same single offscreen document (Chrome allows only one).
 *
 * @module offscreen/index
 */

import { createWorker, PSM, type Worker } from 'tesseract.js'
import { pickOcrCandidate } from '../lib/ocr-candidates'

void chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined
  if (
    message.type !== 'clip-get' &&
    message.type !== 'clip-set' &&
    message.type !== 'ocr-image' &&
    message.type !== 'ocr-warm'
  ) {
    return undefined
  }

  void (async () => {
    try {
      if (message.type === 'clip-get') {
        const text = await navigator.clipboard.readText()
        sendResponse({ ok: true, text })
      } else if (message.type === 'clip-set') {
        await navigator.clipboard.writeText(String(message.text ?? ''))
        sendResponse({ ok: true })
      } else if (message.type === 'ocr-warm') {
        // Pre-compile the WASM core + load the language model so the first real
        // recognition call is fast. Failures are reported and ignored upstream.
        await getOcrWorker(String(message.lang ?? 'eng'))
        sendResponse({ ok: true })
      } else {
        const ocr = await runOcr(String(message.image ?? ''), String(message.lang ?? 'eng'))
        sendResponse({
          ok: true,
          text: ocr.text,
          confidence: ocr.confidence,
          agreed: ocr.agreed,
          alternatives: ocr.alternatives,
        })
      }
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()

  // Keep the message channel open until the async handler responds.
  return true
})

// --- Local OCR (Tesseract.js) --------------------------------------------------

const OCR_BASE = chrome.runtime.getURL('tesseract')

// Tesseract's WASM core + worker load once per document; reusing the worker
// across calls avoids re-compiling the WASM on every recognition.
let ocrWorker: { lang: string; worker: Worker } | null = null

async function getOcrWorker(lang: string): Promise<Worker> {
  if (ocrWorker && ocrWorker.lang === lang) return ocrWorker.worker
  if (ocrWorker) {
    await ocrWorker.worker.terminate().catch(() => undefined)
    ocrWorker = null
  }
  // All assets are vendored under public/tesseract/ so OCR works fully offline.
  // workerBlobURL:false creates the worker directly from the extension URL
  // (keeps the CSP as `script-src 'self'` — no blob: worker needed).
  const worker = await createWorker(lang, 1, {
    workerPath: `${OCR_BASE}/worker.min.js`,
    corePath: `${OCR_BASE}/tesseract-core.wasm.js`,
    langPath: OCR_BASE,
    gzip: true,
    workerBlobURL: false,
  })
  ocrWorker = { lang, worker }
  return worker
}

async function runOcr(
  image: string,
  lang: string,
): Promise<{ text: string; confidence: number; agreed: boolean; alternatives?: string[] }> {
  const worker = await getOcrWorker(lang)
  // The incoming image (a base64/data-URL payload) is painted onto a canvas
  // ONCE and Tesseract recognizes the canvas pixels directly — a single
  // decode, independent of Tesseract's own image-loading path.
  const canvas = await drawToCanvas(image)
  const w = canvas.width
  const h = canvas.height
  // Small, wide captures are single-line text (captchas). Tesseract's auto
  // page segmentation tends to drop the leading glyph there; single-line mode
  // reads them consistently better (verified against live captchas: never
  // worse, and it recovers operands the auto mode loses entirely).
  if (h <= 120 && w / h >= 2.5) {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE })
    try {
      // Self-sufficiency: Tesseract needs ~30px glyphs. When callers skip
      // preprocessing (workflow ocr blocks with preprocess=false, or a failed
      // convenience step), a raw 50x20 captcha arrives and EVERY pass starves.
      // Upscaling here (nearest-neighbour — no ringing on two-tone captcha
      // pixels) restores the validated input size unconditionally.
      let base = canvas
      if (Math.max(w, h) < 120) base = upscaleNearest(canvas, Math.max(3, Math.round(120 / h)))
      // Six candidates, one worker, strictly sequential (~60ms extra): three
      // segmentation modes on the grayscale, plus three on a cleaned binary
      // variant (see cleanBinaryCanvas) — plain SINGLE_LINE/RAW_LINE and a
      // digits-only-whitelisted SINGLE_LINE. Thin-stroke captchas (e.g.
      // jxt56's 50x20 digits) read badly or empty on the grayscale but recover
      // fully on the cleaned binary; wide-spaced arithmetic captchas keep
      // reading best on the plain grayscale. The whitelist pass is a safety
      // net that cannot hurt: offline it matched the unwhitelisted read on
      // every clean sample and forces digit output on marginal ones.
      const readWith = async (target: HTMLCanvasElement, psm: PSM, whitelist?: string) => {
        await worker.setParameters({
          tessedit_pageseg_mode: psm,
          tessedit_char_whitelist: whitelist ?? '',
        })
        const r = await worker.recognize(target)
        return { text: extractText(r), confidence: r.data?.confidence ?? 0 }
      }
      const reads = [
        await readWith(base, PSM.SINGLE_LINE),
        await readWith(base, PSM.SINGLE_BLOCK),
        await readWith(base, PSM.RAW_LINE),
      ]
      const clean = cleanBinaryCanvas(base)
      if (clean) {
        reads.push(await readWith(clean, PSM.SINGLE_LINE))
        reads.push(await readWith(clean, PSM.SINGLE_LINE, '0123456789+-xX*/='))
        reads.push(await readWith(clean, PSM.RAW_LINE))
      }
      const picked = pickOcrCandidate(reads)
      return {
        text: picked.text,
        confidence: picked.confidence,
        agreed: picked.agreed,
        alternatives: picked.alternatives,
      }
    } finally {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, tessedit_char_whitelist: '' })
    }
  }
  const result = await worker.recognize(canvas)
  return { text: extractText(result), confidence: result.data?.confidence ?? 0, agreed: false }
}

/**
 * Loads an image (a data URL of base64 bytes) and paints it onto a canvas at
 * its natural size, so recognition reads canvas pixels. Throws when the image
 * cannot be decoded — the message handler reports that as a failed call.
 */
function drawToCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('OCR canvas unavailable'))
        return
      }
      ctx.drawImage(img, 0, 0)
      resolve(canvas)
    }
    img.onerror = () => reject(new Error('图片无法解码，无法进行 OCR'))
    img.src = dataUrl
  })
}

/**
 * Nearest-neighbour upscale for tiny captcha inputs. Deliberately NOT smooth:
 * two-tone captcha pixels stay two-tone (no ringing halos), which is what the
 * cleaned-binary pipeline and Tesseract's LSTM were validated against.
 */
function upscaleNearest(canvas: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = Math.min(2400, canvas.width * factor)
  out.height = Math.min(2400, canvas.height * factor)
  const ctx = out.getContext('2d')
  if (!ctx) return canvas
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(canvas, 0, 0, out.width, out.height)
  return out
}

/**
 * Builds a "cleaned binary" variant of a captcha-shaped image, tuned on live
 * jxt56 samples (50x20 thin-stroke digits with scattered noise dots):
 *
 * 1. adaptive binarize — threshold halfway between the 2nd-percentile floor
 *    and white;
 * 2. drop connected components shorter than 30% of the image height — noise
 *    dots are a few pixels tall, every glyph spans most of the height (a plain
 *    area threshold fails: upscaled dots grow past it);
 * 3. dilate 1px — reconnects the broken thin strokes;
 * 4. clear a 2px margin — border remnants otherwise read as punctuation.
 *
 * Whole-line reads on this variant were the ONLY ones that recovered every
 * jxt56 sample (the raw grayscale read ~40% empty); they run as ADDITIONAL
 * candidates next to the ordinary grayscale passes, so other captcha styles
 * (e.g. wide arithmetic codes) are never worse off — the structural scorer
 * picks the cleanest read. Returns null when the canvas has no 2d context.
 */
function cleanBinaryCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  const w = canvas.width
  const h = canvas.height
  const ctx = canvas.getContext('2d')
  if (!ctx || w < 4 || h < 4) return null
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, w, h).data
  } catch {
    return null
  }
  const gray = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!
  }
  const sorted = Float32Array.from(gray).sort()
  const k = Math.max(1, Math.floor((w * h) * 0.02))
  const thr = Math.min(200, sorted[k]! + 0.55 * (255 - sorted[k]!))
  const bin = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) bin[i] = gray[i]! < thr ? 1 : 0
  const keep = new Uint8Array(w * h)
  const label = new Int32Array(w * h)
  const minCompHeight = Math.max(4, Math.round(h * 0.3))
  const stack = new Int32Array(w * h)
  let next = 1
  for (let start = 0; start < w * h; start++) {
    if (bin[start] !== 1 || label[start] !== 0) continue
    let sp = 0
    stack[sp++] = start
    label[start] = next
    const comp: number[] = []
    let y0 = h
    let y1 = 0
    while (sp > 0) {
      const p = stack[--sp]!
      comp.push(p)
      const py = (p / w) | 0
      if (py < y0) y0 = py
      if (py > y1) y1 = py
      const px = p % w
      for (const d of [-1, 1, -w, w]) {
        const q = p + d
        if (q < 0 || q >= w * h || bin[q] !== 1 || label[q] !== 0) continue
        if (d === -1 && px === 0) continue
        if (d === 1 && px === w - 1) continue
        label[q] = next
        stack[sp++] = q
      }
    }
    if (y1 - y0 + 1 >= minCompHeight) for (const p of comp) keep[p] = 1
    next++
  }
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let dy = -1; dy <= 1 && !v; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          if (keep[ny * w + nx]) {
            v = 1
            break
          }
        }
      }
      mask[y * w + x] = v
    }
  }
  const M = 2
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < M || y < M || x >= w - M || y >= h - M) mask[y * w + x] = 0
    }
  }
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const octx = out.getContext('2d')
  if (!octx) return null
  const img = octx.createImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    const v = mask[i]! ? 0 : 255
    img.data[i * 4] = v
    img.data[i * 4 + 1] = v
    img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  octx.putImageData(img, 0, 0)
  return out
}

/**
 * Pulls the plain text out of Tesseract's recognize result: dash-like glyphs
 * the LSTM emits for minus signs (— – ―) are normalized to '-' so arithmetic
 * captchas read as clean expressions, then whitespace is collapsed.
 */
function extractText(result: { data?: { text?: string } }): string {
  const text = result?.data?.text ?? ''
  return text
    .replace(/[—–―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}