/**
 * Interpret a JavaScript-code block result as pass or failure.
 *
 * A code node historically only failed when it THREW. Many scripts report an
 * expected outcome through a returned/awaited object instead, e.g.
 *
 * ```js
 * return { success: false, message: '未找到上传图文元素' }
 * ```
 *
 * That was silently treated as success, so downstream blocks ran against a
 * target the script never actually reached. This module applies one shared,
 * conservative rule — pure, with no DOM:
 *
 *   - a non-null object that explicitly carries `success: false` (or `ok:
 *     false`) is a FAILURE, using its `message` / `error` as the reason;
 *   - an object with a non-empty `error` (string/number/object) and no positive
 *     `success`/`ok` marker is also a FAILURE;
 *   - a thrown Error / rejected promise is handled by the caller;
 *   - everything else (including `false` on its own, `{ success: true }`, or a
 *     plain value) is a SUCCESS — we never guess a failure from shape alone.
 *
 * The boolean literal `false` is deliberately NOT a failure: it is a normal
 * predicate result a script may legitimately return to a later condition.
 *
 * @module lib/workflow/script-result
 */

/** Outcome of interpreting one script result value. */
export type ScriptResultVerdict =
  | { ok: true }
  | { ok: false; reason: string }

/** Object shapes inspected as failure envelopes. */
interface FailureEnvelope {
  success?: unknown
  ok?: unknown
  message?: unknown
  error?: unknown
}

function asRecord(value: unknown): FailureEnvelope | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as FailureEnvelope
}

/** Render an envelope reason field as readable text. */
function reasonFromField(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value) ?? null
  } catch {
    return String(value)
  }
}

/**
 * Decide whether the value a script returned (and did not throw for) counts as
 * an expected failure.
 */
export function interpretScriptResult(value: unknown): ScriptResultVerdict {
  const envelope = asRecord(value)
  if (!envelope) return { ok: true }

  const explicitFailure = envelope.success === false || envelope.ok === false
  const message =
    reasonFromField(envelope.message) ?? reasonFromField(envelope.error)

  if (explicitFailure) {
    return { ok: false, reason: message ?? 'script reported failure' }
  }

  // An error field with no positive marker is an error result, not a success.
  const positive = envelope.success === true || envelope.ok === true
  if (!positive && envelope.error !== undefined && envelope.error !== null && envelope.error !== '') {
    return { ok: false, reason: message ?? 'script reported an error' }
  }

  return { ok: true }
}
