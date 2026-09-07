/**
 * Compile-time feature flag for the local OCR engine (Tesseract.js).
 *
 * `__OCR__` is injected by vite.config.ts (`define`): `true` for the full
 * build, `false` for `--mode no-ocr` — the lite release that strips the
 * ~35 MB of vendored Tesseract wasm/language assets. UI surfaces (block
 * palette, canvas nodes, settings) import this constant to gray out or hide
 * OCR-only features; background engine code guards the OCR paths directly
 * with `__OCR__` so no-ocr bundles tree-shake them away.
 *
 * @module lib/ocr-support
 */

export const OCR_SUPPORTED: boolean = __OCR__
