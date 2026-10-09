/**
 * Per-node AI Fix — pure vocabulary, prompt builder, reply parser and data
 * sanitizer for repairing ONE workflow operator node.
 *
 * The repair is bounded by the node's own Goal Contract: the model may only
 * re-author this node's block parameters so that the operator executes without
 * error AND every one of its `successCriteria` (see node-goal-contract) holds
 * against the live page. It must NOT change the block identity, the goal
 * contract, or the workflow graph — those are stripped from any model reply.
 *
 * Everything in this module is pure (no `chrome`, no DOM, no network) so the
 * prompt/parser/sanitizer are unit-testable; the side-effectful loop lives in
 * `background/workflow-engine/node-fix-engine`.
 *
 * @module lib/workflow/node-fix
 */

import { stripThinkBlocks } from '../model-output'
import { describeCondition, type WorkflowCondition } from './conditions'
import { WORKFLOW_AI_NAMESPACE } from './node-goal-contract'

/** Bounded repair rounds for one node (initial verify + model-driven retries). */
export const NODE_FIX_MAX_ROUNDS = 3

/** The human-meaningful phases a node-fix run moves through. */
export type NodeFixPhase =
  | 'observing' // observe the current page / URL before diagnosing
  | 'executing' // trial-run the operator with the current data
  | 'diagnosing' // call the AI with failure evidence + goal contract
  | 'applying' // adopt the candidate data, about to re-verify
  | 'verifying' // evaluate the success criteria

/** One streamed progress event while a node fix is running. */
export interface NodeFixEvent {
  sessionId: string
  phase: NodeFixPhase
  /** 0-based round. */
  round: number
  /** Human-readable detail (already safe to show); phase label is mapped in UI. */
  message: string
  status?: 'running' | 'done' | 'error'
}

/** The final node-fix result. */
export interface NodeFixResultData {
  success: boolean
  reason?: string
  rounds: number
  /** On success: the validated, complete node blockData for the user to apply. */
  proposedData?: Record<string, unknown>
}

/** Inputs to the prompt builder. */
export interface NodeFixPromptInput {
  blockId: string
  goal: string
  successCriteria: WorkflowCondition[]
  userSuggestion: string
  currentData: Record<string, unknown>
  /** Last trial-run error, when the executor failed. */
  execError?: string
  /** Names/descriptions of the success criteria that did not hold. */
  unmetCriteria: string[]
  /** Best-effort summary of the live page, when available. */
  pageSummary?: string
}

/** Cap per string value shipped to the model so one node can't blow context. */
const VALUE_CAP = 400

/** Keys the model is never allowed to author. */
export const NODE_FIX_RESERVED_KEYS: ReadonlySet<string> = new Set([
  'blockId',
  WORKFLOW_AI_NAMESPACE,
])

/** JSON.stringify replacer that truncates long strings (applies recursively). */
function truncateStrings(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) =>
    typeof val === 'string' && val.length > VALUE_CAP ? `${val.slice(0, VALUE_CAP)}…` : val,
  )
}

/**
 * Builds the node-fix prompt. English scaffolding (models follow it reliably).
 * The model returns the COMPLETE re-authored node parameters; the goal and
 * success criteria are stated as the fixed target the parameters must achieve.
 */
export function buildNodeFixPrompt(input: NodeFixPromptInput): string {
  const lines: string[] = []
  lines.push(
    'You are the node-repair agent inside a browser-automation Chrome extension.',
    'You repair ONE workflow operator node by editing ONLY its parameters.',
    '',
    '## The target this node must achieve (fixed — do not change it)',
    `Block: ${input.blockId}`,
    `Goal: ${input.goal}`,
    'Success criteria (ALL must hold after the node runs):',
  )
  input.successCriteria.forEach((condition, i) => {
    lines.push(`  ${i + 1}. ${describeCondition(condition)}`)
  })
  lines.push('')
  if (input.userSuggestion.trim()) {
    lines.push(
      '## User repair guidance (follow when consistent with the goal)',
      input.userSuggestion,
      '',
    )
  }
  lines.push('## Current node parameters', `params: ${truncateStrings(input.currentData)}`, '')
  if (input.execError && input.execError.trim()) {
    lines.push('## Last execution error', truncateStrings(input.execError), '')
  }
  if (input.unmetCriteria.length > 0) {
    lines.push(
      '## Success criteria that did NOT hold',
      ...input.unmetCriteria.map((text) => `- ${text}`),
      '',
    )
  }
  if (input.pageSummary && input.pageSummary.trim()) {
    lines.push('## Live page summary', truncateStrings(input.pageSummary), '')
  }
  lines.push(
    '## Rules',
    '- Edit the parameters so the operator achieves the Goal and ALL success criteria hold on the real page.',
    '- Prefer stable locators (#id, [data-testid], [name]) and waits after navigation; avoid brittle nth-child chains and generated classes.',
    '- Preserve variable references like {{variableName}} and every parameter unrelated to the failure.',
    '- Do NOT change the block id, the goal, the success criteria, or any workflow connections/structure.',
    '- If the goal is impossible with this block on this page, still return the closest correct parameters and explain in the rationale.',
    '',
    '## Response format',
    'Respond with ONLY a JSON object — no markdown fence, no commentary:',
    '{"rationale":"<one or two sentences: what was wrong and what you changed>","data":{ ...the COMPLETE node parameters } }',
    '"data" must be the full parameter object (start from the current parameters), not only the changed keys.',
  )
  return lines.join('\n')
}

/** Parsed node-fix reply. */
export interface NodeFixReply {
  rationale: string
  data: Record<string, unknown>
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

/**
 * Parses the model's reply into a rationale + raw data object. Returns null
 * when there is no usable JSON object with an object `data` field.
 */
export function parseNodeFixReply(text: string): NodeFixReply | null {
  const cleaned = stripThinkBlocks(text)
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  if (!isPlainRecord(parsed['data'])) return null
  const rationale = typeof parsed['rationale'] === 'string' ? parsed['rationale'].trim() : ''
  return { rationale: rationale || '(no rationale provided)', data: parsed['data'] }
}

/**
 * Deeply validates untrusted model-authored node data.
 *
 * - must be a plain, JSON-serializable object (functions/symbols are dropped);
 * - reserved keys (`blockId`, the `__workflowAi` namespace) are removed so the
 *   model can never change the block identity or the goal contract;
 * - returns a fresh deep copy (no reference sharing with the model object).
 *
 * Returns null only when the top-level value is not a plain object.
 */
export function sanitizeNodeData(
  raw: unknown,
  _baseData?: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!isPlainRecord(raw)) return null
  // Recursively clean the ORIGINAL (not structuredClone, which throws on
  // functions/symbols); cleanRecord builds a fresh object so no references are
  // shared with the caller.
  return cleanRecord(raw)
}

function cleanRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (NODE_FIX_RESERVED_KEYS.has(key)) continue
    const cleaned = cleanValue(value)
    if (cleaned !== undefined) out[key] = cleaned
  }
  return out
}

function cleanValue(value: unknown): unknown {
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return value
  if (t === 'bigint' || t === 'function' || t === 'symbol' || t === 'undefined') return undefined
  if (Array.isArray(value)) {
    const items: unknown[] = []
    for (const item of value) {
      const cleaned = cleanValue(item)
      if (cleaned !== undefined) items.push(cleaned)
    }
    return items
  }
  if (isPlainRecord(value)) return cleanRecord(value)
  // Non-plain objects (Date, Map, class instances…) are not authored.
  return undefined
}
