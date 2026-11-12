/**
 * Static extraction of the variables a `javascript-code` script writes.
 *
 * The kernel's script environment publishes variables two ways: the explicit
 * `automaSetVariable(name, value)` helper, and assignments onto the shared
 * `variables` object. Both land in the same session-variable store that later
 * blocks read as `{{name}}`, but neither is declared in the block's `data` —
 * the only way a static reader (the `/` menu, completeness checks, provenance)
 * can know the names is to read the code.
 *
 * This is a heuristic, not a parser: it recognises the documented shapes and
 * deliberately misses dynamic names (computed keys, non-literal arguments).
 * A missed name only means the editor offers fewer suggestions; a false
 * positive only adds one. Consumers merge the extraction with the block's
 * declared `data.outputVariables` (see {@link mergeScriptOutputNames}).
 *
 * @module lib/workflow/script-outputs
 */

/** A legal `{{name}}` reference: an identifier-like token. */
const VARIABLE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * One alternation, not three patterns scanned in turn: a single pass keeps
 * first-appearance order across shapes. Capture groups: 2 = the name in an
 * `automaSetVariable('name', …)` call, 3 = a `variables.name =` target,
 * 5 = a `variables['name'] =` target.
 */
const WRITE_PATTERN =
  /\bautomaSetVariable\s*\(\s*(['"`])([^'"`]+)\1|\bvariables\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*=|\bvariables\s*\[\s*(['"`])([^'"`]+)\4\s*\]\s*=/g

/**
 * Variable names the script code writes, in first-appearance order.
 * The engine's own `lastResult` (whatever the script returns) is not
 * extracted here — it is an alias, added by the block-level knowledge in
 * `producer-completeness`, not something the code names.
 */
export function scriptOutputVariableNames(code: string): string[] {
  const names = new Set<string>()
  if (!code) return []
  for (const match of code.matchAll(WRITE_PATTERN)) {
    const name = (match[2] ?? match[3] ?? match[5] ?? '').trim()
    if (name && VARIABLE_NAME.test(name)) names.add(name)
  }
  return [...names]
}

/**
 * Declared `outputVariables` plus what the code actually writes, deduplicated,
 * declared names first. A name declared but never written still counts: the
 * author may assign it dynamically (loops, computed keys) beyond the static
 * extraction's reach.
 */
export function mergeScriptOutputNames(declared: readonly unknown[], code: string): string[] {
  const names = new Set<string>()
  for (const item of declared) {
    const name = typeof item === 'string' ? item.trim() : ''
    if (name && VARIABLE_NAME.test(name)) names.add(name)
  }
  for (const name of scriptOutputVariableNames(code)) names.add(name)
  return [...names]
}
