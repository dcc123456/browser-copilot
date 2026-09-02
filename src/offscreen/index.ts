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

import { createWorker, type Worker } from 'tesseract.js'

void chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined
  if (message.type !== 'clip-get' && message.type !== 'clip-set' && message.type !== 'ocr-image') {
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
      } else {
        sendResponse({ ok: true, text: await runOcr(String(message.image ?? ''), String(message.lang ?? 'eng')) })
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

async function runOcr(image: string, lang: string): Promise<string> {
  const worker = await getOcrWorker(lang)
  const result = await worker.recognize(image)
  return extractText(result)
}

/** Pulls the plain text out of Tesseract's recognize result, whitespace-trimmed. */
function extractText(result: { data?: { text?: string } }): string {
  const text = result?.data?.text ?? ''
  return text.replace(/\s+/g, ' ').trim()
}