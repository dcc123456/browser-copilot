import type { WireMessage, WireToolCall } from './llm'

/**
 * Context compaction for long conversations.
 *
 * Every prior message is re-sent on each model request, so an accumulating
 * transcript eventually approaches the model's context window. When the last
 * reported input-token count reaches 80% of the 256K window, the conversation
 * history is compacted BEFORE the next request: older turns (assistant answers
 * AND their tool exchanges) are replaced by a single LLM-written summary
 * message, while user messages and the most recent turns stay verbatim.
 *
 * The summarizer is injected so this module stays free of LLM/network wiring;
 * the agent passes a `streamCompletion`-backed implementation with a mechanical
 * digest as the failure fallback.
 */

/** Assumed model context window (tokens). */
export const CONTEXT_WINDOW_TOKENS = 256_000
/** Compaction trigger: a fraction of the window, leaving headroom for the next answer. */
export const COMPACT_THRESHOLD_RATIO = 0.8
export const COMPACT_THRESHOLD_TOKENS = CONTEXT_WINDOW_TOKENS * COMPACT_THRESHOLD_RATIO
/** Turns kept verbatim (the current turn plus this many previous ones). */
export const COMPACT_KEEP_RECENT_TURNS = 2

/** Per-message cap in the transcript handed to the summarizer (chars). */
const SUMMARY_PER_MESSAGE_CHARS = 4_000
/** Total transcript cap (chars); overflowing lines are dropped from the middle. */
const SUMMARY_TOTAL_CHARS = 60_000
/** Fallback digest: first chars kept per removed message when the LLM fails. */
const DIGEST_PER_MESSAGE_CHARS = 200

export function shouldCompact(lastInputTokens: number): boolean {
  return lastInputTokens >= COMPACT_THRESHOLD_TOKENS
}

// --- Token estimation (for requests that never reported usage) ---------------------
//
// The server reports prompt_tokens only AFTER a request succeeds. When a
// conversation grows large without a prior usage report (first long turn,
// non-reporting endpoint, or history accumulated mid-turn), the real size is
// unknown and the over-limit request 400s before any token is counted. The
// estimators below bound that case. They deliberately OVER-estimate: a CJK
// code point counts as one token (Qwen's BPE is CJK-dense) and other text as
// ~0.35 token/char (~3 chars/token).

/** Conservative token estimate for a piece of text. */
export function estimateTextTokens(text: string): number {
  let tokens = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const isCjk =
      (code >= 0x3000 && code <= 0x30ff) || // CJK punctuation, hiragana, katakana
      (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
      (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
      (code >= 0xff00 && code <= 0xffef) // full/halfwidth forms
    if (isCjk) tokens += 1
    else if (ch.trim() !== '') tokens += 0.35
  }
  return Math.ceil(tokens)
}

/** Conservative token estimate for one wire message (struct + content + calls). */
export function estimateMessageTokens(message: WireMessage): number {
  let tokens = 4 // per-message structural overhead
  const loose = message as Record<string, unknown>
  if (typeof loose['content'] === 'string') tokens += estimateTextTokens(loose['content'])
  if (typeof loose['name'] === 'string') tokens += estimateTextTokens(loose['name'])
  for (const call of (loose['tool_calls'] as WireToolCall[] | undefined) ?? []) {
    tokens += estimateTextTokens(call.function.name)
    tokens += estimateTextTokens(call.function.arguments)
    tokens += 4
  }
  return tokens
}

/**
 * Total estimated input size of a request array. Extra text (serialised tool
 * schemas, system prompt carried outside the array) is converted at the
 * non-CJK rate when it is not passed as its own message.
 */
export function estimateInputTokens(
  messages: WireMessage[],
  extra?: { text?: string; messages?: WireMessage[] },
): number {
  const body = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
  const addedMessages = extra?.messages?.reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    0,
  ) ?? 0
  const addedText = extra?.text ? estimateTextTokens(extra.text) : 0
  return body + addedMessages + addedText + 2
}

/**
 * Last-resort emergency bound: shorten the CONTENT of the largest messages
 * (oldest non-user messages first) until the estimated size fits
 * tokenBudget. Messages are never deleted here (that would orphan tool-call
 * pairs); they are truncated in place. User messages are touched only if every
 * other message is gone and the budget still does not fit. Returns the number
 * of characters removed.
 */
export function hardCapHistory(
  history: WireMessage[],
  tokenBudget: number,
): number {
  if (estimateInputTokens(history) <= tokenBudget) return 0
  let removed = 0
  const truncate = (message: WireMessage): boolean => {
    if (typeof message.content !== 'string' || message.content.length <= 300) return false
    const excessTokens = estimateInputTokens(history) - tokenBudget
    // Convert the token excess to chars at the dense rate (+ margin), but keep
    // at least 300 chars of the message.
    const wantedCut = Math.ceil(excessTokens / 0.9) + 16
    const cut = Math.min(message.content.length - 300, wantedCut)
    message.content = `${message.content.slice(0, message.content.length - cut)}\u2026[truncated]`
    removed += cut
    return true
  }
  // Pass 1: keep truncating the oldest non-user messages that still hold
  // content, iterating until the budget fits or none of them is cuttable.
  let progressed = true
  while (progressed && estimateInputTokens(history) > tokenBudget) {
    progressed = false
    for (const message of history) {
      if (estimateInputTokens(history) <= tokenBudget) return removed
      if (message.role !== 'user' && truncate(message)) progressed = true
    }
  }
  // Pass 2: user content only as the final emergency.
  progressed = true
  while (progressed && estimateInputTokens(history) > tokenBudget) {
    progressed = false
    for (const message of history) {
      if (estimateInputTokens(history) <= tokenBudget) return removed
      if (truncate(message)) progressed = true
    }
  }
  return removed
}

export interface CompactOutcome {
  /** Removed messages replaced by the summary. */
  removed: number
  summary: string
}

export interface CompactOptions {
  /** i18n prefix stamped onto the summary message ("[上下文已压缩] …"). */
  marker: string
  keepRecentTurns?: number
  /**
   * Produces the replacement summary from the removed messages' transcript.
   * May reject — a mechanical digest is used instead, so compaction never
   * blocks the turn.
   */
  summarize?: (transcript: string) => Promise<string>
}

/** One labelled line per removed message for the summarizer's input. */
function renderForSummary(message: WireMessage): string {
  const cap = (text: string): string =>
    text.length > SUMMARY_PER_MESSAGE_CHARS
      ? `${text.slice(0, SUMMARY_PER_MESSAGE_CHARS)}…`
      : text
  if (message.role === 'user') return `user: ${cap(message.content)}`
  if (message.role === 'tool') {
    const name = message.name ? `(${message.name})` : ''
    return `tool${name}: ${cap(message.content)}`
  }
  if (message.role !== 'assistant') return ''
  const calls = (message.tool_calls ?? [])
    .map((call: WireToolCall) => `→ calls ${call.function.name}`)
    .join('; ')
  return [`assistant: ${cap(message.content ?? '')}`, calls].filter(Boolean).join(' ')
}

/** Mechanical digest used when the LLM summarizer fails or returns nothing. */
function digest(lines: string[]): string {
  return lines.map((line) => line.slice(0, DIGEST_PER_MESSAGE_CHARS)).join('\n')
}

/** Caps the transcript: per-line first, then drops middle lines over the total cap. */
function boundTranscript(lines: string[]): string {
  if (lines.join('\n').length <= SUMMARY_TOTAL_CHARS) return lines.join('\n')
  // Keep the newest and oldest lines (task setup and the latest state matter
  // most); the middle of a very long transcript is the least informative.
  const head: string[] = []
  const tail: string[] = []
  let budget = SUMMARY_TOTAL_CHARS
  let i = 0
  let j = lines.length - 1
  while (i <= j) {
    const headLine = lines[i]
    if (headLine !== undefined && headLine.length + 1 <= budget) {
      head.push(headLine)
      budget -= headLine.length + 1
      i += 1
      continue
    }
    const tailLine = lines[j]
    if (tailLine !== undefined && tailLine.length + 1 <= budget) {
      tail.unshift(tailLine)
      budget -= tailLine.length + 1
      j -= 1
      continue
    }
    break
  }
  const result = [...head, ...tail].join('\n')
  return result.length > 0 ? result : digest(lines)
}

/**
 * Compacts `history` IN PLACE (like `retireOldPageReads`), so the next
 * `saveConversation` persists the compacted transcript and restores replay it.
 *
 * Turns are delimited by user messages. The most recent `keepRecentTurns`
 * turns stay untouched; in every older turn, non-user messages (assistant
 * answers, tool-call exchanges, tool results) are removed and replaced by ONE
 * user-role summary message inserted at the position of the first removal.
 * User messages are never removed.
 *
 * Returns null when there is nothing to compact (too few turns, or the
 * compactable span holds no non-user messages).
 */
export async function compactHistory(
  history: WireMessage[],
  options: CompactOptions,
): Promise<CompactOutcome | null> {
  const keep = options.keepRecentTurns ?? COMPACT_KEEP_RECENT_TURNS

  // Turn starts: every user message opens a turn; anything before the first
  // user message (not produced by the chat pipeline) is its own segment.
  const starts: number[] = []
  for (let i = 0; i < history.length; i += 1) {
    if (history[i]?.role === 'user') starts.push(i)
  }
  const segments: Array<[number, number]> = []
  const firstStart = starts[0]
  if (firstStart !== undefined && firstStart > 0) segments.push([0, firstStart])
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]
    if (start === undefined) continue
    const next = starts[i + 1]
    segments.push([start, next ?? history.length])
  }
  const compactable = segments.length - keep
  if (compactable <= 0) return null

  const removable: number[] = []
  for (const [from, to] of segments.slice(0, compactable)) {
    for (let i = from; i < to; i += 1) {
      if (history[i]?.role !== 'user') removable.push(i)
    }
  }
  const firstRemoved = removable[0]
  if (firstRemoved === undefined) return null

  const lines = removable.map((i) => renderForSummary(history[i] as WireMessage))
  let summary = ''
  if (options.summarize) {
    try {
      summary = (await options.summarize(boundTranscript(lines))).trim()
    } catch {
      summary = ''
    }
  }
  if (!summary) summary = digest(lines)

  const summaryMessage: WireMessage = {
    role: 'user',
    content: `${options.marker}\n${summary}`,
  }
  // Insert at the first removal, then drop the removed messages. Splicing
  // from the highest index keeps the lower indices valid.
  history.splice(firstRemoved, 0, summaryMessage)
  for (let i = removable.length - 1; i >= 0; i -= 1) {
    const index = removable[i]
    if (index === undefined) continue
    history.splice(index + 1, 1)
  }
  return { removed: removable.length, summary }
}
