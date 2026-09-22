/**
 * Redaction helpers (spec §5.1, §7).
 *
 * Traces and repair contexts may keep variable NAMES and node ids, but never
 * raw secret values: passwords, cookies, tokens, API keys, 2FA/CAPTCHA values.
 * This module turns any value into a stable {@link VariableValueSummary}
 * (exists / empty / type / length / short hash), and recognises sensitive
 * variable names so callers know to drop the value entirely.
 *
 * Pure — no browser dependencies.
 *
 * @module lib/workflow/repair/redaction
 */

import type { VariableValueSummary } from './types'

/**
 * Variable-name fragments that mark a value as sensitive. Matched
 * case-insensitively against the lower-cased name.
 */
const SENSITIVE_FRAGMENTS: readonly string[] = [
  'password',
  'passwd',
  'pwd',
  'cookie',
  'token',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'authcode',
  'captcha',
  'twofa',
  '2fa',
  'otp',
  'credential',
  'privatekey',
  'private_key',
]

/** True when `name` looks like a credential / one-time secret. */
export function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase()
  return SENSITIVE_FRAGMENTS.some((fragment) => lower.includes(fragment))
}

/** FNV-1a 32-bit hash over a string (stable, dependency-free). */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

function valueLength(value: unknown): number | undefined {
  if (typeof value === 'string' || Array.isArray(value)) return value.length
  if (value && typeof value === 'object') return Object.keys(value).length
  return undefined
}

/**
 * Summarize a variable value without retaining it.
 *
 * `redacted` is true for sensitive names OR values that could not be safely
 * serialized. The hash is computed from the serialized form when available so
 * identical values compare equal without the value ever leaving this layer.
 */
export function summarizeValue(value: unknown, name = ''): VariableValueSummary {
  const sensitive = name ? isSensitiveName(name) : false
  if (value === undefined) {
    return { exists: false, type: 'undefined', redacted: false }
  }
  if (value === null) {
    return { exists: true, type: 'null', redacted: false }
  }

  const type = Array.isArray(value) ? 'array' : typeof value
  const isEmpty =
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && Object.keys(value).length === 0)
      ? true
      : undefined
  const length = valueLength(value)

  if (sensitive) {
    return { exists: true, isEmpty, type, length, redacted: true }
  }

  try {
    const json = JSON.stringify(value)
    return {
      exists: true,
      isEmpty,
      type,
      length,
      redacted: false,
      hash: fnv1a(json),
    }
  } catch {
    // Non-serializable (functions, circular structures) — cannot keep it.
    return { exists: true, isEmpty, type, length, redacted: true }
  }
}

/** Summaries for a whole variable bag, keyed by variable name. */
export function summarizeVariables(
  variables: Readonly<Record<string, unknown>>,
): Record<string, VariableValueSummary> {
  const out: Record<string, VariableValueSummary> = {}
  for (const [name, value] of Object.entries(variables)) {
    out[name] = summarizeValue(value, name)
  }
  return out
}
