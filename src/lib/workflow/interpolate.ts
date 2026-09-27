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
 * Params key the ENGINE sets on the interpolated parameter bag, listing the
 * `{{token}}` expressions that resolved to NOTHING and were therefore left
 * verbatim in the text (e.g. `{{productName}}` when no node ever produced that
 * variable).
 *
 * A page-action executor uses this to fail the NODE with `UNRESOLVED_INPUT`
 * instead of typing the literal `{{productName}}` into a search box: the run
 * fails where the mistake is, and the message names the token the graph is
 * missing. It is not a gate on saving — a workflow with an unfilled input is
 * still a workflow, and the declared input's default normally fills it here.
 *
 * Never persisted; exists only on the per-run interpolated copy.
 */
export const UNRESOLVED_INTERP_KEY = '__bcUnresolvedInterp'

/** The `{{expr}}` tokens still present in a string, in order, deduplicated. */
function leftoverTokens(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(TOKEN)) {
    const expr = (match[1] ?? '').trim()
    if (expr && !found.includes(expr)) found.push(expr)
  }
  return found
}

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
/**
 * Walk a param bag recursively, interpolating every string.
 *
 * Alongside the interpolated value, each result carries the `{{tokens}}` that
 * survived the pass anywhere below it — a nested `target.fallbacks` row with a
 * hole in it is as unresolved as a top-level `value`, and the caller cannot see
 * it by re-scanning the value, because an unchanged branch returns the
 * ORIGINAL object reference.
 */
function interpolateValue(
  value: unknown,
  vars: Record<string, unknown>,
  refData?: unknown,
): { value: unknown; changed: boolean; tokens: string[] } {
  if (typeof value === 'string') {
    if (!value.includes('{{')) return { value, changed: false, tokens: [] }
    const next = interpolate(value, vars, refData)
    return { value: next, changed: next !== value, tokens: leftoverTokens(next) }
  }
  if (Array.isArray(value)) {
    let changed = false
    const tokens: string[] = []
    const out = value.map((item) => {
      const result = interpolateValue(item, vars, refData)
      if (result.changed) changed = true
      for (const token of result.tokens) if (!tokens.includes(token)) tokens.push(token)
      return result.value
    })
    // Keep the ORIGINAL reference when nothing changed: most nodes carry nested
    // objects (`target`, `onError`, …), and allocating a copy for each of them
    // on every step of every run would defeat the identity check below.
    return changed ? { value: out, changed: true, tokens } : { value, changed: false, tokens }
  }
  if (value !== null && typeof value === 'object') {
    let changed = false
    const tokens: string[] = []
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const result = interpolateValue(item, vars, refData)
      if (result.changed) changed = true
      for (const token of result.tokens) if (!tokens.includes(token)) tokens.push(token)
      out[key] = result.value
    }
    return changed ? { value: out, changed: true, tokens } : { value, changed: false, tokens }
  }
  return { value, changed: false, tokens: [] }
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
  const unresolved: string[] = []
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
    // Tokens that survived the pass anywhere in the param are the ones no
    // variable answered for — `{{x}}.price` in a selector is a locator with a
    // hole in it, and so is one buried in a nested `target` row.
    for (const token of result.tokens) {
      if (!unresolved.includes(token)) unresolved.push(token)
    }
  }
  if (empty.length > 0) {
    out[EMPTY_INTERP_KEY] = empty
    changed = true
  }
  if (unresolved.length > 0) {
    out[UNRESOLVED_INTERP_KEY] = unresolved
    changed = true
  }
  return changed ? out : data
}
