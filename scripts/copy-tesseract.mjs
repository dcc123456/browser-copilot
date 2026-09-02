/**
 * Vendors the local Tesseract.js OCR assets into `public/tesseract/` so they
 * are bundled with the extension and reachable via `chrome.runtime.getURL`.
 *
 * The browser build of tesseract.js normally fetches its worker, WASM core and
 * language traineddata from a CDN at runtime. Keeping them local makes OCR work
 * fully offline (no network required for recognition).
 *
 * Copied files (all idempotent — existing files are left untouched):
 *   public/tesseract/worker.min.js            tesseract.js worker script
 *   public/tesseract/tesseract-core.wasm.js   the WASM core (universal build)
 *   public/tesseract/eng.traineddata.gz       English LSTM language data
 *
 * `tesseract-core.wasm.js` embeds the WASM binary, so no separate .wasm file is
 * needed. The core must match the tesseract.js major version (7).
 */
import { mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destDir = resolve(ROOT, 'public', 'tesseract')

const SOURCES = [
  // worker script
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  // WASM core (universal, non-SIMD build — matches tesseract.js-core@7.0.0)
  ['node_modules/tesseract.js-core/tesseract-core.wasm.js', 'tesseract-core.wasm.js'],
]

/** tesseract.js ships no language data; we download the official tall-data gz once. */
const LANGS = [
  { name: 'eng', url: 'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz' },
  { name: 'chi_sim', url: 'https://tessdata.projectnaptha.com/4.0.0/chi_sim.traineddata.gz' },
]

mkdirSync(destDir, { recursive: true })

let copied = 0
for (const [src, file] of SOURCES) {
  const target = resolve(destDir, file)
  if (existsSync(target)) continue
  copyFileSync(resolve(ROOT, src), target)
  copied += 1
}

const TIMEOUT_MS = 300_000 // traineddata can be MBs; allow 5 min per file.
const RETRIES = 3

/** Downloads a file to a path with a generous timeout and retry-on-failure. */
async function download(url, target) {
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        const resp = await fetch(url, { signal: controller.signal })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        writeFileSync(target, Buffer.from(await resp.arrayBuffer()))
        return
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      if (attempt === RETRIES) throw new Error(`failed to fetch ${url}: ${error.message}`)
      process.stdout.write(`retry ${attempt}/${RETRIES} for ${url}\n`)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
}

for (const { name, url } of LANGS) {
  const target = resolve(destDir, `${name}.traineddata.gz`)
  if (existsSync(target)) continue
  process.stdout.write(`downloading ${name}.traineddata.gz …\n`)
  try {
    await download(url, target)
    copied += 1
  } catch (error) {
    // Optional language data: never break the build when the download fails
    // (e.g. an offline sandbox). The OCR tool reports a clear error at runtime
    // if a user requests a language whose data is missing.
    process.stdout.write(`WARN: skipping ${name} language data: ${error.message}\n`)
  }
}

if (copied === 0) {
  process.stdout.write('tesseract assets already present, nothing to copy.\n')
} else {
  process.stdout.write(`copied ${copied} tesseract asset(s) into public/tesseract/.\n`)
}