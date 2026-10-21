/**
 * Text cleanup for chat replies.
 *
 * Some models append a `<details><summary>Summary</summary>…</details>` block
 * that restates the conversation (a hand-off summary format picked up from
 * their training data, not part of the answer). It leaks into the visible
 * reply and, once persisted, teaches the next turn to imitate it. The filter
 * here removes exactly those blocks — a `<details>` whose summary title is
 * "Summary" — and passes every other `<details>` (skill explanations, log
 * viewers) through untouched.
 *
 * Streaming-aware: tags can be split across deltas, so the filter holds back
 * text that may still turn out to be the start of a candidate block.
 *
 * @module lib/chat-output
 */

/** Longest title we keep buffering while waiting for `</summary>` to decide. */
const SUMMARY_TITLE_MAX = 80

/** Title that marks a block as a session summary. */
const SUMMARY_TITLE = 'summary'

/** A whole-text filter surface; see {@link createSessionSummaryFilter}. */
export interface SessionSummaryFilter {
  /** Feeds one streamed delta; returns the text safe to show now. */
  push(delta: string): string
  /** Ends the stream; returns the remaining text (dropping an unclosed block). */
  end(): string
}

/**
 * The `<details…>` open tag. The lookahead keeps `<detailsx` from matching but
 * allows `<details>` and `<details open>`.
 */
const DETAILS_OPEN = /<details(?=[\s>])/i
const SUMMARY_OPEN = /^<summary(?=[\s>])/i
const SUMMARY_CLOSE = /<\/summary\s*>/i

/** Longest suffix of `text` that is a prefix of one of `tags`. */
function partialTagSuffix(text: string, tags: readonly string[]): string {
  const lower = text.toLowerCase()
  let longest = 0
  for (const tag of tags) {
    // The full tag counts: `<details` with no following character yet may
    // still become an open tag, so it has to be held, not emitted.
    const max = Math.min(tag.length, lower.length)
    for (let length = max; length > longest; length -= 1) {
      if (lower.endsWith(tag.slice(0, length))) {
        longest = length
        break
      }
    }
  }
  return text.slice(text.length - longest)
}

/** True when `text` could still grow into `<summary…>` with more input. */
function isPartialSummaryOpen(text: string): boolean {
  // `<=`: the buffer may end exactly at `<summary`, before the `>` (or an
  // attribute space) that the open-tag regex needs.
  return text.length <= '<summary'.length && '<summary'.startsWith(text.toLowerCase())
}

/** True when `text` could still grow into `</summary>` with more input. */
function isPartialSummaryClose(text: string): boolean {
  const lower = text.toLowerCase()
  if (!lower.startsWith('</summary')) return '</summary'.startsWith(lower)
  // Past the name only whitespace may stand before the `>` (which has not
  // arrived yet, or the close regex would have matched).
  return !lower.includes('>') && lower.slice('</summary'.length).trim() === ''
}

/**
 * Longest suffix that could still become a `<details>` / `</details>` tag.
 * Needed while swallowing: a close tag split across deltas (`</detai` + `ls>`)
 * must survive the discard, or the block would never be considered closed.
 */
function partialDetailsSuffix(text: string): string {
  const lower = text.toLowerCase()
  const start = lower.lastIndexOf('<')
  if (start < 0) return ''
  const tail = lower.slice(start)
  if (tail.startsWith('<details')) return tail.includes('>') ? '' : text.slice(start)
  if (tail.startsWith('</details')) {
    return tail.slice('</details'.length).trim() === '' ? text.slice(start) : ''
  }
  if ('</details'.startsWith(tail) || '<details'.startsWith(tail)) return text.slice(start)
  return ''
}

/**
 * Creates a stateful filter for one reply stream.
 *
 * Emits text as soon as it cannot belong to a candidate block. A confirmed
 * session summary is swallowed through its matching `</details>` (nesting
 * counted); when the stream ends inside one, the whole block is dropped
 * because its title already identified it as noise.
 */
export function createSessionSummaryFilter(): SessionSummaryFilter {
  let buffer = ''
  // >0 while discarding a block whose summary title was "Summary".
  let swallowDepth = 0

  const scan = (final: boolean): string => {
    let out = ''
    for (;;) {
      if (swallowDepth > 0) {
        const tags = /<details(?:\s[^>]*)?>|<\/details\s*>/gi
        let consumed = 0
        let closed = false
        for (let match = tags.exec(buffer); match; match = tags.exec(buffer)) {
          consumed = match.index + match[0].length
          swallowDepth += match[0].startsWith('</') ? -1 : 1
          if (swallowDepth === 0) {
            closed = true
            break
          }
        }
        buffer = buffer.slice(consumed)
        if (closed) continue
        if (final) {
          buffer = ''
          return out
        }
        buffer = partialDetailsSuffix(buffer)
        return out
      }

      const open = DETAILS_OPEN.exec(buffer)
      if (!open) {
        if (final) {
          out += buffer
          buffer = ''
          return out
        }
        const hold = partialTagSuffix(buffer, ['<details'])
        out += buffer.slice(0, buffer.length - hold.length)
        buffer = hold
        return out
      }

      const start = open.index
      const gt = buffer.indexOf('>', start)
      if (gt < 0) {
        if (final) {
          out += buffer
          buffer = ''
          return out
        }
        out += buffer.slice(0, start)
        buffer = buffer.slice(start)
        return out
      }
      const openEnd = gt + 1
      let cursor = openEnd
      while (cursor < buffer.length && /\s/.test(buffer[cursor] as string)) cursor += 1

      if (cursor >= buffer.length) {
        if (!final) {
          out += buffer.slice(0, start)
          buffer = buffer.slice(start)
          return out
        }
        // A `<details…>` with nothing after it cannot be a summary block.
        out += buffer.slice(0, openEnd)
        buffer = buffer.slice(openEnd)
        continue
      }

      const after = buffer.slice(cursor)
      const summary = SUMMARY_OPEN.exec(after)
      if (!summary) {
        if (!final && isPartialSummaryOpen(after)) {
          out += buffer.slice(0, start)
          buffer = buffer.slice(start)
          return out
        }
        // Not a summary block: release the open tag and rescan the body
        // normally, so a later candidate inside it is still considered.
        out += buffer.slice(0, openEnd)
        buffer = buffer.slice(openEnd)
        continue
      }

      const summaryGt = buffer.indexOf('>', cursor + summary[0].length)
      if (summaryGt < 0) {
        if (!final) {
          out += buffer.slice(0, start)
          buffer = buffer.slice(start)
          return out
        }
        out += buffer
        buffer = ''
        return out
      }

      const titleStart = summaryGt + 1
      const close = SUMMARY_CLOSE.exec(buffer.slice(titleStart))
      if (!close) {
        const titleSoFar = buffer.slice(titleStart)
        // The title is still streaming, or the closing tag is split: hold.
        const cut = titleSoFar.indexOf('<')
        const titlePart = cut < 0 ? titleSoFar : titleSoFar.slice(0, cut)
        const undecided =
          titlePart.length <= SUMMARY_TITLE_MAX &&
          (cut < 0 || isPartialSummaryClose(titleSoFar.slice(cut)))
        if (!final && undecided) {
          out += buffer.slice(0, start)
          buffer = buffer.slice(start)
          return out
        }
        if (final) {
          out += buffer
          buffer = ''
          return out
        }
        // Too long or contains markup: not a session summary title.
        out += buffer.slice(0, titleStart)
        buffer = buffer.slice(titleStart)
        continue
      }
      const closeEnd = titleStart + close.index + close[0].length
      const title = buffer
        .slice(titleStart, titleStart + close.index)
        .trim()
        .toLowerCase()
      if (title === SUMMARY_TITLE) {
        // Release the text before the block, drop the block head, and keep
        // scanning for the matching close.
        out += buffer.slice(0, start)
        buffer = buffer.slice(closeEnd)
        swallowDepth = 1
        continue
      }
      // A different summary (a skill panel, a log viewer…): pass it through.
      out += buffer.slice(0, closeEnd)
      buffer = buffer.slice(closeEnd)
    }
  }

  return {
    push: (delta) => {
      buffer += delta
      return scan(false)
    },
    end: () => scan(true),
  }
}

/** Removes session-summary `<details>` blocks from already-complete text. */
export function stripSessionSummaryBlocks(text: string): string {
  const filter = createSessionSummaryFilter()
  return filter.push(text) + filter.end()
}
