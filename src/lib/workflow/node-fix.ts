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
 * A node with no contract can still be repaired from the user's prompt plus the
 * failure output (specs/2026-10-16-node-fix-from-prompt-only-design.md). Then the
 * judgement is a TEMPORARY criterion: the model returns one page-checkable
 * condition with its parameters, the page decides whether it held, and nothing is
 * written to the node. When no criterion ever arrives, success is reported as
 * `exec-only` — the trial run did not throw, and that is all the dialog may claim.
 *
 * Everything in this module is pure (no `chrome`, no DOM, no network) so the
 * prompt/parser/sanitizer are unit-testable; the side-effectful loop lives in
 * `background/workflow-engine/node-fix-engine`.
 *
 * @module lib/workflow/node-fix
 */

import { stripThinkBlocks } from '../model-output'
import { describeCondition, workflowConditionsOf, type WorkflowCondition } from './conditions'
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
  /**
   * The concrete data behind this step, as pre-formatted text: `request` is what
   * the step sent (the model request, the parameters a trial run used, the page
   * state read), `response` is what came back (the AI's returned parameters, the
   * criterion verdicts). Formatted by the engine so every consumer shows the SAME
   * log and none has to invent its own formatting.
   */
  payload?: { request?: string; response?: string }
}

/** The final node-fix result. */
export interface NodeFixResultData {
  success: boolean
  reason?: string
  rounds: number
  /** On success: the validated, complete node blockData for the user to apply. */
  proposedData?: Record<string, unknown>
  /**
   * On success: WHAT the success claim rests on. `criteria` means the operator ran
   * without error and every page criterion (the node's own contract or the
   * temporary one) held; `exec-only` means there was nothing on the page to check,
   * so all we know is that the trial run did not throw. The dialog must say which
   * — reporting a verified fix without a verifiable criterion is the fake-success
   * pattern the acceptance suite forbids.
   */
  verifiedBy?: 'criteria' | 'exec-only'
}

/** Inputs to the prompt builder. */
export interface NodeFixPromptInput {
  blockId: string
  /** The node's stored goal. Absent for a prompt-only repair (see §3 of the design). */
  goal?: string
  successCriteria: WorkflowCondition[]
  userSuggestion: string
  currentData: Record<string, unknown>
  /** Last trial-run error, when the executor failed. */
  execError?: string
  /** The failure output the user pasted, when the node has no stored contract. */
  errorLog?: string
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
 *
 * Two target shapes. With a stored contract the goal and criteria are the user's
 * own and fixed. Without one (§3 of the 2026-10-16 prompt-only design) the user's
 * prompt IS the goal, and the model must also hand back the one machine-checkable
 * criterion it believes proves success — the page, not the model, then decides.
 */
export function buildNodeFixPrompt(input: NodeFixPromptInput): string {
  const lines: string[] = []
  lines.push(
    'You are the node-repair agent inside a browser-automation Chrome extension.',
    'You repair ONE workflow operator node by editing ONLY its parameters.',
    '',
  )
  if (input.goal) {
    lines.push(
      '## The target this node must achieve (fixed — do not change it)',
      `Block: ${input.blockId}`,
      `Goal: ${input.goal}`,
      'Success criteria (ALL must hold after the node runs):',
    )
    input.successCriteria.forEach((condition, i) => {
      lines.push(`  ${i + 1}. ${describeCondition(condition)}`)
    })
  } else {
    lines.push(
      '## The target this node must achieve (no stored contract — taken from the user)',
      `Block: ${input.blockId}`,
      `Goal, as the user stated it: ${input.userSuggestion.trim() || '(see the error log)'}`,
    )
    if (input.successCriteria.length > 0) {
      lines.push('Success criterion agreed for this repair (must hold after the node runs):')
      input.successCriteria.forEach((condition, i) => {
        lines.push(`  ${i + 1}. ${describeCondition(condition)}`)
      })
    } else {
      lines.push(
        'Success criteria: none agreed yet, so return a "verify" object alongside "data".',
        'It must be ONE machine-checkable fact about the page after this node runs, in the',
        'condition shape, e.g. {"kind":"elementValue","target":{"selector":"#search"},',
        '"expectation":"notEmpty"} or {"kind":"urlContains","value":"/home"}.',
      )
    }
  }
  lines.push('')
  // With a contract the prompt is guidance next to a fixed goal; without one it IS
  // the goal, already stated above — restating it would double the token cost.
  if (input.goal && input.userSuggestion.trim()) {
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
  if (input.errorLog && input.errorLog.trim()) {
    lines.push(
      '## Error log from the failed run (pasted by the user)',
      truncateStrings(input.errorLog),
      '',
    )
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
    '- Edit the parameters so the operator achieves the Goal and every success criterion holds on the real page.',
    '- Prefer stable locators (#id, [data-testid], [name]) and waits after navigation; avoid brittle nth-child chains and generated classes.',
    '- Preserve variable references like {{variableName}} and every parameter unrelated to the failure.',
    '- Do NOT change the block id, the goal, the success criteria, or any workflow connections/structure.',
    '- If the goal is impossible with this block on this page, still return the closest correct parameters and explain in the rationale.',
    '',
    '## Response format',
    'Respond with ONLY a JSON object — no markdown fence, no commentary:',
    input.goal
      ? '{"rationale":"<what was wrong and what you changed>","data":{ ...the COMPLETE node parameters } }'
      : '{"rationale":"<what was wrong and what you changed>","data":{ ...the COMPLETE node parameters },"verify":{ ...ONE page-checkable criterion, or null } }',
    '"data" must be the full parameter object (start from the current parameters), not only the changed keys.',
  )
  return lines.join('\n')
}

/** Parsed node-fix reply. */
export interface NodeFixReply {
  rationale: string
  data: Record<string, unknown>
  /**
   * The criterion the model proposes for THIS repair, when the reply carried a
   * usable one. Never stored on the node — see `temporaryCriterionOf`.
   */
  verify?: WorkflowCondition
}

/**
 * Read one model-authored success criterion out of an untrusted reply.
 *
 * Reuses the tolerant condition reader the persisted contracts go through, so a
 * hallucinated or malformed shape yields `undefined` — which means "no criterion
 * to check", never a crash and never a pass.
 */
export function temporaryCriterionOf(value: unknown): WorkflowCondition | undefined {
  if (value === null || value === undefined) return undefined
  return workflowConditionsOf([value])[0]
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
  const verify = temporaryCriterionOf(parsed['verify'])
  return {
    rationale: rationale || '(no rationale provided)',
    data: parsed['data'],
    ...(verify ? { verify } : {}),
  }
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

// --- Live fix log (one event stream, rendered by both dialogs) ----------------

/** Cap one prose value the way the prompt caps parameter strings. */
function capText(text: string): string {
  return text.length > VALUE_CAP ? `${text.slice(0, VALUE_CAP)}…` : text
}

/**
 * What the repair was actually told, as log text — the same fields
 * {@link buildNodeFixPrompt} puts into the request, minus its English scaffolding,
 * so the displayed request and the sent one cannot drift apart.
 */
export function nodeFixRequestPayloadOf(input: NodeFixPromptInput): string {
  const lines: string[] = [
    `block: ${input.blockId}`,
    `params: ${truncateStrings(input.currentData)}`,
  ]
  if (input.goal) lines.push(`goal: ${capText(input.goal)}`)
  if (input.successCriteria.length > 0) {
    lines.push(`criteria: ${input.successCriteria.map(describeCondition).join(' / ')}`)
  }
  if (input.unmetCriteria.length > 0) lines.push(`unmet: ${input.unmetCriteria.join(' / ')}`)
  if (input.execError?.trim()) lines.push(`error: ${capText(input.execError.trim())}`)
  if (input.errorLog?.trim()) lines.push(`error log: ${capText(input.errorLog.trim())}`)
  if (input.userSuggestion.trim()) lines.push(`prompt: ${capText(input.userSuggestion.trim())}`)
  if (input.pageSummary?.trim()) lines.push(`page: ${capText(input.pageSummary.trim())}`)
  return lines.join('\n')
}

/** The node parameters one step ran with, as log text. */
export function nodeFixParamsPayloadOf(data: Record<string, unknown>): string {
  return truncateStrings(data)
}

/** What the model answered: its rationale, the parameters it returned, its check. */
export function nodeFixReplyPayloadOf(reply: NodeFixReply): string {
  const lines = [`rationale: ${capText(reply.rationale)}`, `params: ${truncateStrings(reply.data)}`]
  if (reply.verify) lines.push(`check: ${describeCondition(reply.verify)}`)
  return lines.join('\n')
}

/** Each criterion and whether the page agreed — the verdicts the loop judged by. */
export function nodeFixVerdictPayloadOf(
  outcomes: readonly { condition: WorkflowCondition; satisfied: boolean }[],
): string {
  if (outcomes.length === 0) return '(no criterion to check)'
  return outcomes
    .map((outcome) => `${outcome.satisfied ? '✓' : '✗'} ${describeCondition(outcome.condition)}`)
    .join('\n')
}

/** Localized labels a plain-text consumer supplies for one log line. */
export interface NodeFixLogLabels {
  /** The round prefix, e.g. `R2` / `第 2 轮`. */
  round: (round: number) => string
}

/** Collapse a multi-line payload into one readable log line. */
function inlinePayload(text: string): string {
  return text.replace(/\s*\n\s*/g, ' | ')
}

/**
 * Project one streamed event into the plain log lines a text-only consumer shows
 * (the chat's workflow dialog). Both dialogs render the SAME stream, so their
 * fix logs say the same thing; the payload is data, so it needs no label of its
 * own — each line of it already says what it holds (`params:`, `rationale:`).
 */
export function nodeFixLogLinesOf(event: NodeFixEvent, labels: NodeFixLogLabels): string[] {
  const head = labels.round(event.round)
  const lines = [event.message.trim() ? `${head} · ${event.message.trim()}` : head]
  for (const text of [event.payload?.request, event.payload?.response]) {
    if (text?.trim()) lines.push(`${head} · ${inlinePayload(text.trim())}`)
  }
  return lines
}
