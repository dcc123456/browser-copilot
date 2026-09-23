/**
 * Runtime input generalization (spec §7 · Commit 04).
 *
 * Promotes obvious BUSINESS inputs — values the user supplies per run — from
 * captured literals into declared trigger parameters referenced as
 * `{{token}}`. Unlike record-time {@link rewriteDataParams} (value-driven),
 * this pass is TASK-TEXT driven: it reads what the user actually asked for and
 * promotes the captured literals that realize it.
 *
 * Example:
 *
 * ```
 * taskText: "Search Amazon for iPhone 17 Pro Max and add it to the cart"
 * recorded forms value: "iPhone 17 Pro Max"
 *   → declared input `keyword` (defaultValue kept for out-of-the-box runs)
 *   → node value rewritten to {{keyword}}
 * ```
 *
 * Sensitive filtering is enforced BEFORE anything is promoted or exposed to a
 * prompt: passwords, API keys, tokens, cookies and session-like values never
 * become candidates, and an external URL is distinguished from a keyword.
 *
 * Pure module: no `chrome`, no DOM, no I/O. The actual trigger mutation is
 * returned as declarations and applied by the caller through
 * `mergeTriggerInputs`, keeping one input shape across all creation paths.
 *
 * @module lib/workflow/input-generalization
 */

import type { WorkflowDraft } from './draft-types'
import type { DeclaredInput } from './dynamic-data'
import type { WorkflowNode } from './types'

/** A parameterizable literal observed on a node. */
export interface InputCandidateBase {
  nodeId: string
  path: string
  value: string
}

export interface GeneralizedInput {
  name: string
  candidate: InputCandidateBase
}

export interface GeneralizationResult {
  draft: WorkflowDraft
  /** Inputs to declare on the trigger (via mergeTriggerInputs). */
  declarations: DeclaredInput[]
  /** Nodes (id) whose data was rewritten to a {{token}}. */
  rewrittenNodeIds: string[]
  /** Candidate values rejected as sensitive. */
  blockedSensitive: string[]
  notes: string[]
}

// --- sensitive detection ---------------------------------------------------

/**
 * Heuristic names that mark a value as sensitive. Key/context based — the
 * value itself is not shipped to a prompt, so naming is enough to refuse.
 */
const SENSITIVE_NAME_PATTERNS: ReadonlyArray<RegExp> = [
  /password/i,
  /passwd/i,
  /secret/i,
  /api[_-]?key/i,
  /access[_-]?token/i,
  /auth[_-]?token/i,
  /bearer\s+/i,
  /session[_-]?id/i,
  /cookie/i,
]

/** Value shapes that read as secrets even without a labelled name. */
const SENSITIVE_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  // Bearer / JWT-ish
  /^Bearer\s+[A-Za-z0-9._-]{8,}$/i,
  /^eyJ[A-Za-z0-9._-]{8,}$/,
  // Long hex / base64 single tokens (api keys), but not short business codes.
  /^[A-Za-z0-9_-]{32,}$/,
]

/** True when a value must never be parameterized or sent to a prompt. */
export function isSensitiveValue(value: string): boolean {
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    if (pattern.test(value)) return true
  }
  return false
}

/** True when a candidate's name/context marks it sensitive. */
export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME_PATTERNS.some((pattern) => pattern.test(name))
}

// --- task-text entity hints -------------------------------------------------

/**
 * Task-text hints for the PARAMETER NAME to use, matched in order. Each entry
 * maps a recognizable intent to a stable name. Only the value is captured —
 * the hint is never sent anywhere verbatim beyond local naming.
 */
const TASK_NAME_HINTS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /\bsearch(?:ing)? (?:for )?/i, name: 'keyword' },
  { pattern: /\bkeyword\b/i, name: 'keyword' },
  { pattern: /\border(?:\s+number)?\b|\borderId\b/i, name: 'orderId' },
  { pattern: /\bproduct\b|\bitem name\b/i, name: 'product' },
  { pattern: /\bcity\b/i, name: 'city' },
  { pattern: /\bdate\b/i, name: 'date' },
  { pattern: /\bemail\b/i, name: 'email' },
  { pattern: /\busername\b|\baccount\b/i, name: 'username' },
]

/** Derive a parameter name from the task text, or undefined. */
export function nameHintFromTaskText(taskText: string | undefined): string | undefined {
  if (!taskText) return undefined
  for (const hint of TASK_NAME_HINTS) {
    if (hint.pattern.test(taskText)) return hint.name
  }
  return undefined
}

// --- candidate collection --------------------------------------------------

function blockIdOf(node: WorkflowNode): string {
  const fromData = node.data?.['blockId']
  return typeof fromData === 'string' && fromData ? fromData : node.label
}

const TOKEN_REFERENCE = /\{\{[^{}]*\}\}/
const URLISH = /^https?:\/\//i

/**
 * Collect parameterizable literals from the draft: forms fill values that are
 * neither references nor URLs (a URL is navigation, not a keyword).
 */
export function collectGeneralizationCandidates(draft: WorkflowDraft): InputCandidateBase[] {
  const candidates: InputCandidateBase[] = []
  for (const node of draft.nodes) {
    if (blockIdOf(node) !== 'forms') continue
    const value = node.data?.['value']
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed || TOKEN_REFERENCE.test(trimmed)) continue
    if (URLISH.test(trimmed)) continue
    candidates.push({ nodeId: node.id, path: 'value', value: trimmed })
  }
  return candidates
}

/** Replace a leaf on a node data clone (single-level path here). */
function withParam(node: WorkflowNode, path: string, next: string): WorkflowNode {
  return { ...node, data: { ...node.data, [path]: next } }
}

/**
 * Generalize the business inputs of a draft.
 *
 * Returns a new draft plus the trigger declarations. Only candidates whose
 * value appears in (or is clearly implied by) the task text are promoted;
 * sensitive values are blocked. When no explicit name can be derived, a
 * neutral name is used so the review card still shows the knob.
 */
export function generalizeInputs(
  input: WorkflowDraft,
  options: { nameHint?: string } = {},
): GeneralizationResult {
  const taskText = input.goalText
  const hinted = options.nameHint ?? nameHintFromTaskText(taskText)
  const notes: string[] = []
  const blockedSensitive: string[] = []

  const declarations: DeclaredInput[] = []
  const declaredNames = new Set<string>()
  const valueToName = new Map<string, string>()

  // Only promote values the task text actually contains (task-driven) when a
  // task text exists; otherwise leave the draft untouched (no over-promotion).
  const candidates = collectGeneralizationCandidates(input)
  for (const candidate of candidates) {
    if (isSensitiveValue(candidate.value)) {
      blockedSensitive.push(candidate.value)
      continue
    }
    if (isSensitiveName(candidate.path) || isSensitiveName(candidate.nodeId)) {
      blockedSensitive.push(candidate.value)
      continue
    }
    if (taskText && !taskText.includes(candidate.value)) {
      // Not a realization of the user's stated task; do not parameterize.
      notes.push(`skipped ${candidate.nodeId}: not present in task text`)
      continue
    }

    let name = valueToName.get(candidate.value)
    if (!name) {
      name = hinted ?? 'input'
      // Disambiguate a name reused for a different value.
      let unique = name
      let suffix = 2
      while (declaredNames.has(unique) && valueToName.get(candidate.value) !== unique) {
        unique = `${name}${suffix}`
        suffix += 1
      }
      name = unique
      declaredNames.add(name)
      valueToName.set(candidate.value, name)
      declarations.push({
        name,
        defaultValue: candidate.value,
        description: `generalized from ${candidate.nodeId}.${candidate.path} during generation`,
      })
    }
  }

  // Apply the rewrites to a cloned node list.
  const rewrittenNodeIds: string[] = []
  const nodes = input.nodes.map((node) => {
    const declaration = declarations.find(
      (d) =>
        d.defaultValue ===
          (typeof node.data?.['value'] === 'string' ? (node.data['value'] as string).trim() : '') &&
        blockIdOf(node) === 'forms',
    )
    if (!declaration) return node
    rewrittenNodeIds.push(node.id)
    return withParam(node, 'value', `{{${declaration.name}}}`)
  })

  const draft: WorkflowDraft = { ...input, nodes }
  for (const declaration of declarations) {
    notes.push(`declared ${declaration.name} for "${declaration.defaultValue}"`)
  }

  return { draft, declarations, rewrittenNodeIds, blockedSensitive, notes }
}
