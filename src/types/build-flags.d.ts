/**
 * Build-time feature flags injected by vite.config.ts via `define`.
 *
 * `__OCR__` — local OCR (Tesseract.js) support. `true` for the default/full
 * build; `false` for `--mode no-ocr` (the lite release without the vendored
 * Tesseract wasm/language assets). Engine code guarded by `if (__OCR__)` is
 * dead-code-eliminated in no-ocr bundles; UI code reads the same flag through
 * `OCR_SUPPORTED` (src/lib/ocr-support.ts) to disable OCR-only features.
 *
 * `__BUILD_STAMP__` — hash of the sources this bundle was compiled from
 * (`scripts/build-stamp.mjs`). The local agent bridge reports it so a self-test
 * can tell WHICH build the browser is running instead of assuming a reload took
 * effect. Empty string when no sources could be hashed (a test run).
 */
declare const __OCR__: boolean
declare const __BUILD_STAMP__: string
