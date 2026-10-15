#!/usr/bin/env node
/**
 * Firefox build → `dist-firefox/`. Same sources as the Chrome build, assembled
 * for Firefox 128+ (see specs/2026-10-15-firefox-support-design.md).
 *
 * Why three vite passes instead of one config:
 * - Firefox MV3 uses an EVENT PAGE, not a service worker: the manifest declares
 *   `background.scripts` + `type: "module"`, so `background.js` is emitted as a
 *   stable-named ESM entry while HTML pages keep hashed asset names.
 * - Content scripts are classic scripts in Firefox — no imports allowed — so
 *   each one is bundled as a self-contained IIFE by its own lib-mode pass.
 * The pages pass runs first and owns emptyOutDir/copyPublicDir; the content
 * passes must not clear what it wrote.
 *
 * `define.chrome = 'browser'` is the whole namespace story: Firefox implements
 * `chrome.*` callback-style only, while its native `browser.*` returns
 * promises — which is what the codebase's `await chrome.…` expects. The alias
 * is compile-time (esbuild define), so `typeof chrome` guards simply read as
 * `typeof browser` (true on Firefox), and strings like 'chrome-extension://'
 * are untouched. No polyfill, no call-site rewrites.
 */
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceFingerprintSync } from './build-stamp.mjs'
import { CONTENT_SCRIPT_SOURCES } from './manifest-shared.ts'
import { contentScriptFile, firefoxManifest } from './manifest-firefox.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, 'dist-firefox')
const fromRoot = (relative: string): string => join(root, relative)

const define = {
  // Firefox's chrome.* namespace is callback-only; browser.* returns promises.
  chrome: 'browser',
  // Firefox has no offscreen documents and the OCR path depends on one, so the
  // Firefox build is the no-ocr variant by construction (UI grays out OCR-only
  // operators via the existing OCR_SUPPORTED flag).
  __OCR__: 'false',
  __BUILD_STAMP__: JSON.stringify(sourceFingerprintSync(root)),
}

// Pass 1 — HTML pages + the ESM background event page.
await build({
  root,
  configFile: false,
  plugins: [react(), tailwindcss()],
  define,
  build: {
    target: 'firefox128',
    outDir,
    emptyOutDir: true,
    // Same rationale as vite.config.ts: the background's runtime `import()` of
    // the executors must not get Vite's DOM-touching preload wrapper.
    modulePreload: false,
    minify: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        sidepanel: fromRoot('src/sidepanel/index.html'),
        'workflow-editor': fromRoot('src/workflow-editor/index.html'),
        background: fromRoot('src/background/index.ts'),
      },
      output: {
        // The manifest references this exact name; HTML entry paths stay
        // `src/…` so runtime.getURL('src/workflow-editor/index.html') and
        // sidebar_action.default_panel keep working unchanged.
        entryFileNames: ({ name }) =>
          name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})

// Pass 2..N — one self-contained IIFE per content script.
for (const script of CONTENT_SCRIPT_SOURCES) {
  await build({
    root,
    configFile: false,
    define,
    build: {
      target: 'firefox128',
      outDir,
      emptyOutDir: false,
      copyPublicDir: false, // pass 1 already copied public/
      modulePreload: false,
      minify: true,
      sourcemap: false,
      lib: {
        entry: fromRoot(script.source),
        formats: ['iife'],
        // Required by the iife format; nothing references the global.
        name: 'BrowserCopilotInjected',
        fileName: () => contentScriptFile(script.root),
      },
    },
  })
}

// Pass last — the Firefox manifest (scripts/manifest-firefox.ts), assembled
// from the same shared source as the Chrome one.
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(firefoxManifest(), null, 2)}\n`)

// The vendored Tesseract assets would ship ~35 MB of dead weight: the Firefox
// build has no OCR (no offscreen document to run the worker in).
rmSync(join(outDir, 'tesseract'), { recursive: true, force: true })

const required = [
  'manifest.json',
  'background.js',
  ...CONTENT_SCRIPT_SOURCES.map((script) => contentScriptFile(script.root)),
  'src/sidepanel/index.html',
  'src/workflow-editor/index.html',
  'icons/icon-48.png',
]
const missing = required.filter((relative) => !existsSync(join(outDir, relative)))
if (missing.length > 0) {
  console.error(`[build-firefox] missing expected outputs: ${missing.join(', ')}`)
  process.exit(1)
}
console.log(`[build-firefox] dist-firefox/ ready (${required.length} expected paths present)`)
