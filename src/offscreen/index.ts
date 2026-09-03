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
      // Both segmentation modes always run (~20ms extra): their agreement
      // signals a trustworthy read, and their disagreement feeds the
      // candidate comparison instead of silently picking one.
      const line = await worker.recognize(canvas)
      const lineText = extractText(line)
      const lineConf = line.data?.confidence ?? 0
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK })
      const block = await worker.recognize(canvas)
      const blockText = extractText(block)
      const blockConf = block.data?.confidence ?? 0
      const picked = pickOcrCandidate([
        { text: lineText, confidence: lineConf },
        { text: blockText, confidence: blockConf },
      ])
      return {
        text: picked.text,
        confidence: picked.confidence,
        agreed: picked.agreed,
        alternatives: picked.alternatives,
      }
    } finally {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO })
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