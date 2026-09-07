// defineConfig comes from vitest/config, not vite: it is the same function
// widened to accept the `test` block below. Importing it from 'vite' typechecks
// only as long as some file in the same program pulls in Vitest's type
// augmentation, which made this config's validity depend on unrelated includes.
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

/**
 * Build variants driven by `mode`:
 * - default (and `dev`/`test`): the full release, local OCR (Tesseract.js) included.
 * - `no-ocr`: the lite release — the Tesseract.js engine and the ~35 MB of
 *   vendored wasm/language assets under public/tesseract/ are stripped and
 *   OCR-only features are disabled at runtime (see src/lib/ocr-support.ts).
 *
 * `__OCR__` is a compile-time constant: engine code guarded by `if (__OCR__)`
 * is dead-code-eliminated from no-ocr bundles (e.g. the dynamic tesseract.js
 * import), while UI code reads the same flag via OCR_SUPPORTED to gray out
 * OCR-only operators.
 */
export default defineConfig(({ mode }) => {
  const ocrEnabled = mode !== 'no-ocr'
  const outDir = ocrEnabled ? 'dist' : 'dist-no-ocr'
  return {
    plugins: [
      react(),
      tailwindcss(),
      crx({ manifest }),
      // publicDir copies unconditionally, so the no-ocr build removes the
      // vendored Tesseract assets from its output here. (build-zip.mjs prunes
      // the same directory from its staging copy as a belt-and-braces check.)
      ...(ocrEnabled
        ? []
        : [
            {
              name: 'strip-ocr-assets',
              apply: 'build' as const,
              closeBundle() {
                rmSync(join(fileURLToPath(new URL('.', import.meta.url)), outDir, 'tesseract'), {
                  recursive: true,
                  force: true,
                })
              },
            },
          ]),
    ],
    define: {
      __OCR__: JSON.stringify(ocrEnabled),
    },
    build: {
      target: 'chrome116',
      // Each variant builds into its own directory so build-zip.mjs can zip
      // them independently (see the `package` script).
      outDir,
      // Minified, map-free output: the release zip ships straight from dist/, and
      // unminified JS + sourcemaps tripled the download. Local debugging happens
      // against `pnpm dev` or an unpacked dev build, not the published artefact.
      minify: true,
      sourcemap: false,
      rollupOptions: {
        // Extra extension page (the visual workflow editor) opened via
        // chrome.runtime.getURL('src/workflow-editor/index.html'). The side panel
        // is already wired through the manifest and handled by the crx plugin.
        input: {
          'workflow-editor': fileURLToPath(
            new URL('src/workflow-editor/index.html', import.meta.url),
          ),
          offscreen: fileURLToPath(new URL('src/offscreen/index.html', import.meta.url)),
        },
      },
    },
    test: {
      environment: 'node',
      // .tsx too: component render tests use react-dom/server, which needs no DOM
      // environment, so they belong in this same suite.
      include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    },
  }
})
