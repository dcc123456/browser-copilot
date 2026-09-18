/**
 * Credential containment for workflow generation.
 *
 * The rule this module enforces: **the model may learn a credential's NAME,
 * never its value** — with one deliberate exception: when the user types the
 * credential into the chat themselves, it is captured as a `secret` trigger
 * input (see `credentialFillPath` below). During generation the agent drives the
 * real page, so a credential has to reach the page somehow — but it must travel
 * from storage to the executor without passing through the model's context or
 * the recorded graph. Concretely:
 *
 *   - `get-secret` resolves the value into a session-only variable bag that is
 *     never persisted and never echoed back (see `background/operator-tool-run`);
 *   - a node records `{{variableName}}`, never the literal;
 *   - a literal the USER TYPED IN CHAT and handed to a password field is
 *     CAPTURED: it becomes a `secret` trigger input whose `defaultValue` is the
 *     literal, so the generated workflow can replay it via `{{name}}`. This is a
 *     deliberate exception to "never persist a value" — the user provided the
 *     credential themselves in the conversation, so persisting it (as an
 *     editable, overridable trigger input) is consented and what they asked for.
 *
 * Pure functions on purpose: the rules are the part worth testing, and the
 * callers are Chrome-coupled.
 *
 * @module lib/workflow/secret-guard
 */

/**
 * Blocks that write a value into a page element. Only these can leak a literal
 * into a form field; `javascript-code` can of course do anything, but it is
 * arbitrary JS and policed by the mode warning instead.
 */
export const VALUE_FILL_BLOCK_IDS: ReadonlySet<string> = new Set(['forms'])

/** Element `type` values that mark a field as credential-bearing. */
const CREDENTIAL_FIELD_TYPES: ReadonlySet<string> = new Set(['password'])

/** Does this string interpolate a variable at replay time? */
const INTERPOLATION_REFERENCE = /\{\{[^{}]*\}\}/

/**
 * Shortest secret literal that is also searched for as a SUBSTRING of a
 * recorded string. Exact matches are always replaced; substring replacement
 * exists for shapes like `"Bearer <token>"`, and the floor keeps a short
 * password from shredding unrelated parameters.
 */
const MIN_SUBSTRING_SECRET_LENGTH = 8

/** Matches a `{{token}}` interpolation reference. */
export function isInterpolationReference(value: string): boolean {
  return INTERPOLATION_REFERENCE.test(value)
}

/** Is this element a credential-bearing field? */
export function isCredentialFieldType(type: string | undefined): boolean {
  return typeof type === 'string' && CREDENTIAL_FIELD_TYPES.has(type.trim().toLowerCase())
}

/**
 * Every non-empty string in a value tree. Used to index secrets whatever shape
 * an executor stored them in (a plain string today, but nothing guarantees it).
 */
function* stringsIn(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    if (value) yield value
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* stringsIn(item)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) yield* stringsIn(item)
  }
}

/**
 * Secret literal → the `{{variableName}}` reference that stands in for it.
 * Built from the session variable bag plus the set of keys known to hold
 * credentials, so a non-secret variable is never mistaken for one.
 */
export interface SecretIndex {
  readonly byValue: ReadonlyMap<string, string>
}

export const EMPTY_SECRET_INDEX: SecretIndex = { byValue: new Map() }

export function buildSecretIndex(
  variables: Readonly<Record<string, unknown>>,
  secretKeys: ReadonlySet<string>,
): SecretIndex {
  const byValue = new Map<string, string>()
  for (const key of secretKeys) {
    if (!(key in variables)) continue
    for (const literal of stringsIn(variables[key])) {
      // First key wins: two variables holding the same secret are
      // interchangeable, and a stable choice keeps the recorded graph tidy.
      if (!byValue.has(literal)) byValue.set(literal, `{{${key}}}`)
    }
  }
  return { byValue }
}

/** Replace every secret occurrence in one string. */
function scrubString(value: string, index: SecretIndex): string {
  const exact = index.byValue.get(value)
  if (exact) return exact
  let out = value
  for (const [literal, reference] of index.byValue) {
    if (literal.length < MIN_SUBSTRING_SECRET_LENGTH) continue
    if (out.includes(literal)) out = out.split(literal).join(reference)
  }
  return out
}

/** Deep-copy a recorded value with every secret occurrence replaced. */
function scrubValue(value: unknown, index: SecretIndex): unknown {
  if (typeof value === 'string') return scrubString(value, index)
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, index))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubValue(item, index)
    }
    return out
  }
  return value
}

/**
 * The parameters as they should be RECORDED: any secret literal replaced by
 * the `{{variableName}}` reference that resolves to it at replay time.
 *
 * Returns the original object untouched when nothing matched, so the common
 * path allocates nothing.
 */
export function redactRecordedParams(
  data: Record<string, unknown>,
  index: SecretIndex,
): { data: Record<string, unknown>; redacted: boolean } {
  if (index.byValue.size === 0) return { data, redacted: false }
  let redacted = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    const next = scrubValue(value, index)
    if (next !== value) redacted = true
    out[key] = next
  }
  return { data: redacted ? out : data, redacted }
}

/**
 * The data path a credential literal should be captured from, or `null` when the
 * call is not a chat-typed credential fill.
 *
 * Returns the path (e.g. `['value']`) of the literal that must be persisted into
 * a `secret` trigger input. Only one case qualifies: a literal (non-reference)
 * value aimed at a credential field. Everything else is either already a
 * reference or has no credential semantics, and capturing those would wrongly
 * freeze ordinary form data.
 *
 * The caller turns the returned path into a `secretPaths` entry for
 * `rewriteDataParams`, which declares the input and rewrites the node to
 * `{{name}}`.
 */
export function credentialFillPath({
  blockId,
  data,
  targetType,
}: {
  blockId: string
  data: Record<string, unknown>
  targetType?: string
}): (string | number)[] | null {
  if (!VALUE_FILL_BLOCK_IDS.has(blockId)) return null
  if (!isCredentialFieldType(targetType)) return null

  const value = typeof data['value'] === 'string' ? data['value'] : ''
  if (!value.trim()) return null
  if (isInterpolationReference(value)) return null

  return ['value']
}
