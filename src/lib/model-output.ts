/**
 * Normalizers for model output that downstream code consumes verbatim.
 *
 * OpenAI-compatible gateways are inconsistent about where reasoning ends up:
 * reasoning models may inline `<think>…</think>` blocks inside `content`
 * (instead of the separate `reasoning_content` field, which the SSE client
 * already ignores), a stream cut mid-thought leaves an unterminated
 * `<think>`, and models asked for data love wrapping it in a ```json fence.
 * Workflow AI operators (`ai-agent`, `ai-prompt`) store the reply into a
 * variable that later steps fill into form fields, compare in conditions, or
 * parse — wrapper junk there breaks the workflow silently.
 *
 * Everything here is deliberately conservative: only clearly wrapper-shaped
 * text (thinking tags, a single enclosing fence) is removed; an answer with
 * commentary around a fence passes through untouched, because that commentary
 * may be the point of the reply.
 *
 * @module lib/model-output
 */

/** Tag names models actually use for visible chain-of-thought. */
const THINK_TAG_SOURCE = '(?:think|thinking|thought|reasoning)'

const THINK_PAIR = new RegExp(`<${THINK_TAG_SOURCE}>[\\s\\S]*?</${THINK_TAG_SOURCE}>`, 'gi')
const THINK_CLOSE = new RegExp(`</${THINK_TAG_SOURCE}>`, 'gi')
const THINK_OPEN = new RegExp(`<${THINK_TAG_SOURCE}>`, 'i')

/**
 * A reply that is exactly one markdown code fence (optionally language-tagged,
 * ```json / ```text), with nothing before or after it. The inner content is
 * capture 1.
 */
const SINGLE_FENCE = /^```[^\n]*\r?\n([\s\S]*?)\r?\n?```$/

/**
 * Removes reasoning-model thinking blocks from a model reply.
 *
 * Handles, in order:
 *   1. `<think>…</think>` pairs (repeated, any known tag name,
 *      case-insensitive);
 *   2. a lone closing tag — thinking cut off mid-stream by a timeout or token
 *      cap, which drops everything before it;
 *   3. an unterminated opening tag — the whole tail after it is thought (or
 *      nothing at all came after it), so the tail is dropped too.
 */
export function stripThinkBlocks(text: string): string {
  let out = text.replace(THINK_PAIR, '')
  const closes = [...out.matchAll(THINK_CLOSE)]
  const lastClose = closes[closes.length - 1]
  if (lastClose) {
    out = out.slice((lastClose.index ?? 0) + lastClose[0].length)
  } else {
    const open = THINK_OPEN.exec(out)
    if (open) out = out.slice(0, open.index)
  }
  return out
}

/**
 * Unwraps a reply that is exactly one markdown code fence, returning the inner
 * content verbatim. A fence plus any surrounding prose is left untouched —
 * only when the fence IS the whole reply is it clearly wrapper junk around the
 * data the task asked for.
 */
export function unwrapFencedAnswer(text: string): string {
  const match = SINGLE_FENCE.exec(text.trim())
  const inner = match?.[1]
  return inner === undefined ? text : inner
}

/**
 * One-pass normalization for a model reply that will be stored and consumed
 * programmatically: strip thinking blocks, unwrap a single enclosing fence,
 * trim. Idempotent — running it on an already-clean answer changes nothing.
 */
export function sanitizeModelAnswer(text: string): string {
  return unwrapFencedAnswer(stripThinkBlocks(text)).trim()
}
