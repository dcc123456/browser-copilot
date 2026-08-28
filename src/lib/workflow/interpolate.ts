/**
 * Template interpolation for workflow blocks.
 *
 * Blocks can reference live values in their parameter text using `{{name}}`
 * tokens, e.g. `{{userName}}` or `{{row.email}}`, so the same workflow can
 * adapt to the data it runs against. Kept as pure string logic (no chrome /
 * storage dependency) so it is trivially testable.
 *
 * @module lib/workflow/interpolate
 */

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g

/**
 * Walk a dot-separated `path` (e.g. `a.b.0`) across nested objects / arrays.
 * Returns `undefined` for any missing segment or a non-object step.
 */
export function getByPath(root: unknown, path: string): unknown {
  let cursor = root
  for (const segment of path.split('.')) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
      return undefined
    }
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/**
 * Replace every `{{name}}` / `{{name.key}}` token in `text`.
 *
 * - `name` is resolved against `vars`, except the special key `refData` which
 *   resolves to the `refData` value itself (its nested keys work too).
 * - Function and object values are stringified via their `toString`.
 * - Tokens that don't match anything are left in the text unchanged.
 */
export function interpolate(
  text: string,
  vars: Record<string, unknown>,
  refData?: unknown,
): string {
  return text.replace(TOKEN, (whole, expression: string) => {
    const expr = expression.trim()
    if (expr === '') return whole
    const dot = expr.indexOf('.')
    const name = dot === -1 ? expr : expr.slice(0, dot)
    const rest = dot === -1 ? '' : expr.slice(dot + 1)

    const root = name === 'refData' ? refData : vars[name]
    const value = rest === '' ? root : getByPath(root, rest)
    if (value === undefined) return whole
    return typeof value === 'function' ? value.toString() : String(value)
  })
}