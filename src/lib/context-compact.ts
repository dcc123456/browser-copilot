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
