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
 * Params key the ENGINE sets on the interpolated parameter bag, listing the
 * top-level string params whose `{{token}}` values all resolved to an empty
 * string (e.g. an `ai-agent` variable whose block produced nothing).
 *
 * Executors that must not act on an accidentally-empty value (the `forms` fill)
 * check this key to tell "the referenced variable produced nothing" apart from
 * a deliberate `""`. Never persisted — it exists only on the per-run
 * interpolated copy.
 */
export const EMPTY_INTERP_KEY = '__bcEmptyInterp'

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

/** Recurse through plain objects and arrays, interpolating every string. */
function interpolateValue(
  value: unknown,
  vars: Record<string, unknown>,
  refData?: unknown,
): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    if (!value.includes('{{')) return { value, changed: false }
    const next = interpolate(value, vars, refData)
    return { value: next, changed: next !== value }
  }
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const result = interpolateValue(item, vars, refData)
      if (result.changed) changed = true
      return result.value
    })
    // Keep the ORIGINAL reference when nothing changed: most nodes carry nested
    // objects (`target`, `onError`, …), and allocating a copy for each of them
    // on every step of every run would defeat the identity check below.
    return changed ? { value: out, changed: true } : { value, changed: false }
  }
  if (value !== null && typeof value === 'object') {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const result = interpolateValue(item, vars, refData)
      if (result.changed) changed = true
      out[key] = result.value
    }
    return changed ? { value: out, changed: true } : { value, changed: false }
  }
  return { value, changed: false }
}

/**
 * Interpolate every `{{token}}` in a block's parameter bag against the run's
 * variables, ready to hand to the executor.
 *
 * Nested plain objects and arrays are walked too: a `conditions` row's
 * `right: '{{loopIndex}}'` and a `loop-elements` node's
 * `observeElement.selector` are both legitimate places for a token, and
 * restricting this to the top level made them silently type the literal
 * `{{loopIndex}}` into the page.
 *
 * When a param held a token and the whole value came back empty, the param name
 * is listed under {@link EMPTY_INTERP_KEY} so an executor can tell "the
 * reference produced nothing" from a deliberate `""` — the `forms` block relies
 * on this to refuse to clear a field. A token that resolves to NOTHING is left
 * in the text by {@link interpolate} and therefore never reported here.
 *
 * Returns a new bag; `data` is never mutated. When no value changes, the
 * original object is returned as-is so callers on the hot path allocate
 * nothing.
 */
export function interpolateParams(
  data: Record<string, unknown>,
  vars: Record<string, unknown>,
  refData?: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const empty: string[] = []
  let changed = false
  for (const [key, value] of Object.entries(data)) {
    const result = interpolateValue(value, vars, refData)
    if (result.changed) changed = true
    out[key] = result.value
    if (
      typeof value === 'string' &&
      value.includes('{{') &&
      typeof result.value === 'string' &&
      result.value.trim() === ''
    ) {
      empty.push(key)
    }
  }
  if (empty.length > 0) {
    out[EMPTY_INTERP_KEY] = empty
    changed = true
  }
  return changed ? out : data
}
