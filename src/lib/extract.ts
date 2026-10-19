/**
 * Text extraction helpers, kept free of `chrome` and DOM globals so they can be
 * unit-tested directly.
 *
 * @module lib/extract
 */

/** Default character budget for page text handed to the model. */
export const DEFAULT_MAX_CHARS = 12_000

/** Collapses runs of whitespace while preserving paragraph breaks. */
export function collapseWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Truncates on a word boundary when one is reasonably close to the limit,
 * so the model is not handed a word cut in half.
 */
export function truncate(
  input: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): { text: string; truncated: boolean } {
  if (maxChars <= 0) return { text: '', truncated: input.length > 0 }
  if (input.length <= maxChars) return { text: input, truncated: false }

  const hardCut = input.slice(0, maxChars)
  const lastBreak = Math.max(hardCut.lastIndexOf('\n'), hardCut.lastIndexOf(' '))
  // Only honour the boundary if it keeps at least 80% of the budget.
  const text = lastBreak > maxChars * 0.8 ? hardCut.slice(0, lastBreak) : hardCut
  return { text: text.trimEnd(), truncated: true }
}

/** Default per-string budget for a value serialized into a model prompt. */
export const DEFAULT_VALUE_CAP = 400

/**
 * Serialize anything a prompt carries (params, page state, an error object) with
 * every string capped, so one long field cannot blow the context. Applies
 * recursively, `JSON.stringify` replacer semantics.
 */
export function capModelPayload(value: unknown, maxChars: number = DEFAULT_VALUE_CAP): string {
  return JSON.stringify(value, (_key, val: unknown) =>
    typeof val === 'string' && val.length > maxChars ? `${val.slice(0, maxChars)}…` : val,
  )
}
