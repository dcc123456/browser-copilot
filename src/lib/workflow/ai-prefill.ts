/**
 * AI prefill: shared knowledge for turning "copy the model composed itself"
 * into an `ai-agent` node that regenerates the content at replay time.
 *
 * A workflow-generation turn sees the model WRITE the fill value (a post, a
 * reply, a summary). Recorded as a literal — or worse, as a declared input's
 * `defaultValue` — that copy is frozen: every replay repeats the one text the
 * model happened to write that day. The fix, shared by both producers of
 * generated workflows, is to insert an `ai-agent` node before the `forms` node
 * and reference its output variable:
 *
 *   ai-agent (prompt, variableName: aiFillN, actOnPage: false) → forms value `{{aiFillN}}`
 *
 * ONE text, TWO consumers:
 * 1. The history-compile path (`lib/storage.workflowFromHistory`) — the
 *    original implementation, driven by the agent's `fill` steps.
 * 2. The operator record paths (`background/operator-tool-run` and
 *    `background/operator-tool-handler`) — which must hold the same rule, or a
 *    workflow generated through `wf_op_*` hardcodes what a history-compiled
 *    one would regenerate.
 *
 * Pure data + pure functions (no `chrome`, no storage) so both sides and the
 * tests read the SAME definitions.
 *
 * @module lib/workflow/ai-prefill
 */

/** Cap the reference value shipped inside the AI block's prompt. */
export const AI_REFERENCE_CAP = 200

/** Description prefix of the inserted `ai-agent` node; `aiPrefillSteps` strips it. */
export const AI_PREFILL_DESCRIPTION_PREFIX = 'AI 生成表单内容: '

/**
 * Matches a value that is EXACTLY one `{{name}}` reference — the shape a
 * prefill producer and its `forms` consumer pair through. (Same shape as the
 * history compiler's `VAR_TOKEN`; kept here so the pairing rule has one home.)
 */
export const EXACT_REFERENCE = /^\{\{\s*([^{}\s]+)\s*\}\}$/

/**
 * Whether a fill value looks like content the model composed (long free text /
 * multi-line), as opposed to literal data a user would dictate. Explicit data
 * shapes (email / URL / number / date) never count as composed prose.
 */
export function looksAiComposed(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  if (!v.includes('\n') && v.length < 24) return false
  if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(v)) return false
  if (/^https?:\/\//i.test(v)) return false
  if (/^-?\d+([.,]\d+)?$/.test(v)) return false
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(v)) return false
  return true
}

/**
 * The prompt of an inserted prefill node: say what to produce, demand bare
 * fillable text, and anchor it with the conversation's own text as a same-use
 * reference (capped — the prompt is a hint, not a storage slot).
 */
export function aiPrefillPrompt(fieldLabel: string, reference: string): string {
  const capped =
    reference.length > AI_REFERENCE_CAP ? `${reference.slice(0, AI_REFERENCE_CAP)}…` : reference
  return (
    `为网页表单字段「${fieldLabel}」生成要填写的内容。` +
    '直接输出可填入输入框的纯文本，不要解释、不要引号。' +
    `参考（对话中填写的同用途内容）：${capped}`
  )
}

/** The `data` keys an inserted prefill node carries (mirrors the history path). */
export interface AiPrefillNodeData extends Record<string, unknown> {
  description: string
  prompt: string
  findBy: 'cssSelector'
  selector: ''
  actOnPage: false
  useSnapshot: false
  maxToolRounds: 8
  variableName: string
  /** The conversation's literal, kept for the save-card toggle's fallback. */
  referenceValue: string
}

/** Build the `ai-agent` node data for one prefill insertion. */
export function aiPrefillNodeData(options: {
  fieldLabel: string
  referenceValue: string
  variableName: string
}): AiPrefillNodeData {
  return {
    description: `${AI_PREFILL_DESCRIPTION_PREFIX}${options.fieldLabel}`,
    prompt: aiPrefillPrompt(options.fieldLabel, options.referenceValue),
    findBy: 'cssSelector',
    selector: '',
    actOnPage: false,
    useSnapshot: false,
    maxToolRounds: 8,
    variableName: options.variableName,
    referenceValue: options.referenceValue,
  }
}

/**
 * The fill value of a `forms` WRITE call that qualifies for AI prefill, or
 * null.
 *
 * Only prose fills qualify: read mode (`getValue`) reads instead of writes,
 * `select`/`checkbox`/`radio` values are control states the site defines, a
 * value that already carries a `{{reference}}` is somebody else's producer's
 * output, and an empty one has nothing to regenerate.
 */
export function aiPrefillFillValue(data: Record<string, unknown>): string | null {
  if (data['getValue'] === true) return null
  const type = String(data['type'] ?? 'text-field')
  if (type !== 'text-field') return null
  const value = data['value']
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || value.includes('{{')) return null
  return value
}

/**
 * The prefill decision for one `forms` write call, from the model's own
 * `generated` flag with the {@link looksAiComposed} heuristic as fallback.
 *
 * Scoped to `forms` on purpose: the gate it relaxes (`unproducedBulkData`)
 * must keep refusing composed-looking literals pasted into `save-local` /
 * `set-variable` / `webhook` — those are sinks for page-read content, and
 * regenerating a scrape with AI would be worse than replaying it.
 *
 *   - `generated === true`  → the model asserts authorship: prefill.
 *   - `generated === false` → user-dictated or page-read data: never prefill
 *     (the dead-data rewriter declares it a workflow input, which is right).
 *   - unmarked              → the heuristic decides, so an operator call that
 *     ignores the new flag still cannot freeze composed copy.
 *
 * A value an upstream step already produced is skipped either way: the
 * rewriter maps it to `{{thatVariable}}`, which is already dynamic — and the
 * model following the guide's ai-agent → forms recipe lands here.
 */
export function isAiComposedFill(options: {
  blockId: string
  data: Record<string, unknown>
  generated: boolean | undefined
  variableIndex: ReadonlyMap<string, string>
}): string | null {
  if (options.blockId !== 'forms') return null
  const value = aiPrefillFillValue(options.data)
  if (value === null) return null
  if (options.variableIndex.has(value)) return null
  if (options.generated === false) return null
  if (options.generated === true) return value
  return looksAiComposed(value) ? value : null
}
