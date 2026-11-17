/**
 * Runtime JavaScript formatter for the javascript-code block editor.
 *
 * Uses Prettier's browser-safe build (standalone + babel/estree plugins) so
 * formatting happens entirely inside the extension — no network, no Node APIs.
 * The style constants mirror `.prettierrc.json`; keep the two in sync so the
 * editor's one-click format agrees with `pnpm format`.
 *
 * Prettier + its plugins are dynamically imported: a one-click convenience
 * must not bloat the editor's initial bundle (~1 MB of parsers/printers).
 *
 * @module lib/format-code
 */

import type { Options } from 'prettier'

/** Matches `.prettierrc.json` (singleQuote, no semi, 100 cols, 2-space indent). */
const PRETTIER_OPTIONS: Options = {
  parser: 'babel',
  plugins: [], // filled below once the plugins are loaded on demand
  singleQuote: true,
  semi: false,
  printWidth: 100,
  tabWidth: 2,
  trailingComma: 'all',
  arrowParens: 'always',
  endOfLine: 'lf',
}

/**
 * Format a JavaScript snippet with the project style. Rejects on syntax errors
 * so callers can keep the original text and surface an inline message.
 */
export async function formatJavaScriptCode(code: string): Promise<string> {
  const [{ format }, babelPlugin, estreePlugin] = await Promise.all([
    import('prettier/standalone'),
    import('prettier/plugins/babel'),
    import('prettier/plugins/estree'),
  ])
  return format(code, { ...PRETTIER_OPTIONS, plugins: [babelPlugin, estreePlugin] })
}
