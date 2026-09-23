/**
 * Execution evidence — what the failure classifier and the AI-repair loop may
 * SEE about a failed step (spec §10.2).
 *
 * Two hard rules, both enforced here:
 *   1. REDACTION — secrets never leave the machine in evidence: passwords,
 *      tokens, cookies, Authorization headers and card numbers are masked
 *      BEFORE the bundle is built, by pattern, not by trust.
 *   2. LENGTH CAPS — evidence is for decisions, not archives: every field is
 *      capped, the whole bundle has a budget, and the oldest content is
 *      dropped first.
 *
 * @module lib/workflow/execution-evidence
 */

/** The evidence bundle attached to a classified failure. */
export interface ExecutionEvidence {
  /** Page URL at failure time (origin kept, path capped). */
  url?: string
  /** The failing node's own selector, capped. */
  selector?: string
  /** Structured locator refusal evidence (code/matchCount/candidates). */
  locator?: {
    code?: string
    matchCount?: number
    candidates?: Array<{ strategy?: string; score?: number }>
  }
  /** The goal summary the run was pursuing (never the full spec). */
  goalSummary?: string
  /** What was READ from the page (text/value), redacted + capped. */
  readback?: string
  /** Variables implicated in the step, REDACTED (names kept, values masked). */
  variables?: Record<string, string>
  /** Engine step lines tail (already capped by the engine). */
  stepTail?: string[]
}

/** Redaction mask applied over secret-looking values. */
const MASK = '***'

/** Keys whose VALUES are always secrets when they appear in a bag. */
const SECRET_KEY_PATTERN =
  /(password|passwd|pwd|secret|token|cookie|authorization|api[-_]?key|access[-_]?key|session|credential|otp|cvv|cvc|card[-_]?number)/i

/** Value patterns that are secrets even under an innocent key. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^(Bearer|Basic)\s+\S+/i, // auth headers
  /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}$/, // JWT-ish
  /\b\d{13,19}\b/, // card-ish numbers
  /(?:^|;\s*)(?:session|token|auth)=[^;\s]+/i, // cookie fragments
]

/** Cap for any single string field. */
export const EVIDENCE_FIELD_CAP = 300
/** Cap for the readback field (the longest one). */
export const EVIDENCE_READBACK_CAP = 800
/** Cap on step-tail lines. */
export const EVIDENCE_STEP_TAIL_LINES = 10

/** Redact one string: mask secret-looking content, then cap. */
export function redactText(value: string, cap = EVIDENCE_FIELD_CAP): string {
  let out = value
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, (match) => {
      // Keep enough shape to be useful: scheme/label + mask.
      const label = /^(Bearer|Basic)\s+/i.exec(match)?.[0] ?? ''
      return `${label}${MASK}`
    })
  }
  return out.length > cap ? `${out.slice(0, cap)}…(${out.length} chars)` : out
}

/** Redact a variables bag: secret-named keys mask the value entirely. */
export function redactVariables(variables: Record<string, unknown>, cap = 20): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(variables).slice(0, cap)) {
    const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
    out[key] = SECRET_KEY_PATTERN.test(key) ? MASK : redactText(raw, EVIDENCE_FIELD_CAP)
  }
  return out
}

export interface BuildEvidenceInput {
  url?: string
  selector?: string
  locator?: ExecutionEvidence['locator']
  goalSummary?: string
  readback?: string
  variables?: Record<string, unknown>
  stepLines?: string[]
}

/** Assemble a redacted, capped evidence bundle from raw run facts. */
export function buildExecutionEvidence(input: BuildEvidenceInput): ExecutionEvidence {
  const evidence: ExecutionEvidence = {}
  if (input.url) evidence.url = redactText(input.url, 200)
  if (input.selector) evidence.selector = redactText(input.selector, 200)
  if (input.locator) evidence.locator = input.locator
  if (input.goalSummary) evidence.goalSummary = redactText(input.goalSummary, 200)
  if (input.readback) evidence.readback = redactText(input.readback, EVIDENCE_READBACK_CAP)
  if (input.variables && Object.keys(input.variables).length) {
    evidence.variables = redactVariables(input.variables)
  }
  if (input.stepLines?.length) {
    evidence.stepTail = input.stepLines
      .slice(-EVIDENCE_STEP_TAIL_LINES)
      .map((line) => redactText(line, EVIDENCE_FIELD_CAP))
  }
  return evidence
}
