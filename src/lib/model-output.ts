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
const THINK_TAG_NAMES = ['think', 'thinking', 'thought', 'reasoning'] as const

const THINK_TAG_SOURCE = `(?:${THINK_TAG_NAMES.join('|')})`

const THINK_PAIR = new RegExp(`<${THINK_TAG_SOURCE}>[\\s\\S]*?</${THINK_TAG_SOURCE}>`, 'gi')
const THINK_CLOSE = new RegExp(`</${THINK_TAG_SOURCE}>`, 'gi')
const THINK_OPEN = new RegExp(`<${THINK_TAG_SOURCE}>`, 'i')

/**
 * Opening OR closing think tag, tolerating stray attributes
 * (`<thinking class="…">`). Capture 1 is `/` for a closing tag, capture 2 the
 * tag name.
 */
const THINK_TAG_ANY = new RegExp(
  `<(/?)(${THINK_TAG_NAMES.join('|')})(?:\\s[^>]*)?>`,
  'gi',
)

/**
 * A tag-shaped tail a token cut can leave dangling at the end of a stream
 * (`<`, `</t`, `<thinkin`). Matched only to decide whether to hold the
 * fragment back; {@link isThinkTagPrefix} confirms it could become a think tag.
 */
const PARTIAL_TAG_TAIL = /<\/?[a-zA-Z]{0,10}$/

/** One visible segment of a model reply: the model's reasoning vs its answer. */
export interface ThinkSegment {
  kind: 'think' | 'answer'
  text: string
  /**
   * Whether the reasoning block is complete. False while the closing tag has
   * not arrived yet (stream still inside the thought).
   */
  closed: boolean
}

/** True when `fragment` is a cut-off prefix of an opening/closing think tag. */
function isThinkTagPrefix(fragment: string): boolean {
  const lower = fragment.toLowerCase()
  if (lower === '<' || lower === '</') return true
  const body = lower.startsWith('</') ? lower.slice(2) : lower.slice(1)
  return THINK_TAG_NAMES.some((name) => name.startsWith(body))
}

/**
 * Splits a model reply into reasoning (`think`) and `answer` segments,
 * preserving their original order. Streaming-safe:
 *
 *   - an unterminated `<think>` yields one trailing `think` segment with
 *     `closed: false`;
 *   - a tag cut in half by a token boundary (`<thi`, `</thinkin`) is held
 *     back while OUTSIDE a thought, so the raw fragment never flashes inside
 *     the answer;
 *   - a lone closing tag (the opening half was streamed earlier) classifies
 *     the text before it as reasoning;
 *   - repeated blocks, tag-name variants and casing are all handled.
 *
 * Display-oriented: unlike {@link stripThinkBlocks} it keeps the reasoning so
 * the UI can render it in its own collapsible block.
 */
export function splitThinkSegments(input: string): ThinkSegment[] {
  const segments: ThinkSegment[] = []

  const push = (kind: ThinkSegment['kind'], part: string, closed = true): void => {
    if (!part) return
    const last = segments[segments.length - 1]
    if (last && last.kind === kind) {
      last.text += part
      if (kind === 'think' && !closed) last.closed = false
    } else {
      segments.push({ kind, text: part, closed: kind === 'answer' ? true : closed })
    }
  }

  THINK_TAG_ANY.lastIndex = 0
  let inThink = false
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = THINK_TAG_ANY.exec(input)) !== null) {
    const between = input.slice(cursor, match.index)
    const isClose = match[1] === '/'
    if (inThink) {
      if (isClose) {
        push('think', between, true)
        inThink = false
      } else {
        // A stray open tag inside reasoning: treat tag + text as thought text.
        push('think', between + match[0], false)
      }
    } else if (isClose) {
      // Lone closing tag — the opening tag was streamed/cut earlier.
      push('think', between, true)
    } else {
      push('answer', between)
      inThink = true
    }
    cursor = match.index + match[0].length
  }

  const tail = input.slice(cursor)
  if (inThink) {
    push('think', tail, false)
    return segments
  }

  push('answer', tail)

  // Hold back a half-typed tag at the very end so it does not leak into the
  // answer until the next chunk reveals whether it really is a think tag.
  const last = segments[segments.length - 1]
  if (last && last.kind === 'answer') {
    const dangling = PARTIAL_TAG_TAIL.exec(last.text)
    if (dangling && isThinkTagPrefix(dangling[0])) {
      last.text = last.text.slice(0, dangling.index)
      if (last.text.length === 0) segments.pop()
    }
  }

  return segments
}

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
