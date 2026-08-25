/**
 * A small Markdown parser for assistant replies.
 *
 * ## Why parse to a tree instead of producing HTML
 *
 * This text is untrusted. The model may have just read an attacker-controlled
 * page, so its output must be treated as hostile input — and the side panel is a
 * privileged surface: script running here can reach `chrome.storage`, where the
 * user's API keys live. Producing an HTML string (and then needing
 * `dangerouslySetInnerHTML`) would make safety depend on getting sanitization
 * right. Emitting a typed tree that the renderer turns into React elements makes
 * injection structurally impossible instead: there is no path from input text to
 * markup, only to text nodes and element types this module names itself.
 *
 * That is also why no raw-HTML passthrough exists. `<img onerror=…>` in a reply
 * renders as literal characters, which is the correct outcome for a chat panel.
 *
 * ## Why hand-written rather than a Markdown library
 *
 * The scope here is "what an LLM emits into a narrow side panel", which is a
 * predictable subset, and the project otherwise ships zero runtime dependencies.
 * A parser stack would add dozens of transitive packages to a security-sensitive
 * surface for constructs (footnotes, directives, raw HTML) this panel should
 * refuse anyway. Anything unrecognized degrades to literal text, so the failure
 * mode is "looks unformatted", never "renders wrong" or "executes".
 *
 * ## Streaming
 *
 * Replies arrive token by token, so this parser is called on every partial
 * prefix. Constructs therefore have to degrade sanely mid-write: an unterminated
 * code fence reports `closed: false` so the renderer can show it as still
 * arriving, while an unterminated `**` stays literal rather than guessing at an
 * emphasis span that may never close.
 *
 * @module lib/markdown
 */

/** Inline (within-paragraph) content. */
export type Inline =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'strike'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  /** An explicit line break inside one paragraph. */
  | { kind: 'break' }

/** Column alignment from a table's delimiter row. */
export type Align = 'left' | 'center' | 'right' | null

/** One list item, holding blocks so items can nest lists or hold several lines. */
export interface ListItem {
  blocks: Block[]
}

/** Block-level content. */
export type Block =
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'code'; lang: string; value: string; closed: boolean }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'hr' }
  | { kind: 'table'; head: Inline[][]; align: Align[]; rows: Inline[][][] }

/**
 * URL schemes allowed on a link.
 *
 * An allowlist, not a `javascript:` denylist: denylists lose to encoding tricks
 * (`java\tscript:`, `JaVaScRiPt:`, `data:text/html;base64,…`), while an
 * allowlist fails closed on anything unanticipated.
 */
const SAFE_SCHEME = /^(?:https?:|mailto:|tel:)/i

/**
 * Validates a link target, returning null when it must not become an `href`.
 *
 * Control characters are rejected outright rather than stripped: browsers ignore
 * them when resolving a URL, so `java&#9;script:alert(1)` would otherwise pass a
 * scheme check and still execute. A URL containing them is never legitimate here.
 *
 * Scheme-relative and relative targets are refused too — there is no meaningful
 * base document in a side panel, so they could only resolve against the
 * extension's own origin.
 */
export function safeHref(raw: string): string | null {
  const url = raw.trim()
  if (url === '') return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(url)) return null
  if (!SAFE_SCHEME.test(url)) return null
  return url
}

/** True when the character at `index` is escaped by an odd run of backslashes. */
function isEscaped(text: string, index: number): boolean {
  let slashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) slashes += 1
  return slashes % 2 === 1
}

/**
 * True when a `_` delimiter at `index` sits inside a word.
 *
 * Underscores appear constantly in identifiers an assistant discusses
 * (`max_tokens`, `SCHEMA_VERSION`), and treating those as emphasis would both
 * mangle the name and swallow the underscores. Asterisks get no such rule, since
 * intra-word `*` is not meaningful text.
 */
function isIntraWord(text: string, index: number, length: number): boolean {
  const before = text[index - 1]
  const after = text[index + length]
  const wordish = (char: string | undefined): boolean =>
    char !== undefined && /[\p{L}\p{N}_]/u.test(char)
  return wordish(before) && wordish(after)
}

/**
 * Finds the closing run for a delimiter, or -1.
 *
 * Skips escaped delimiters and anything inside a code span, so `` `a * b` `` does
 * not supply a closer for an earlier `*`.
 */
function findCloser(text: string, from: number, delimiter: string): number {
  for (let i = from; i < text.length; i += 1) {
    const char = text[i]
    if (char === undefined) break
    if (char === '\\') {
      i += 1
      continue
    }
    // A code span binds tighter than emphasis; jump over it entirely.
    if (char === '`') {
      const run = runLength(text, i, '`')
      const end = findCodeSpanEnd(text, i + run, run)
      if (end !== -1) {
        i = end + run - 1
        continue
      }
    }
    if (text.startsWith(delimiter, i)) {
      if (delimiter === '_' && isIntraWord(text, i, delimiter.length)) continue
      return i
    }
  }
  return -1
}

/** Length of the run of `char` starting at `index`. */
function runLength(text: string, index: number, char: string): number {
  let length = 0
  while (text[index + length] === char) length += 1
  return length
}

/** Finds a backtick run of exactly `length`, or -1. */
function findCodeSpanEnd(text: string, from: number, length: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] !== '`') continue
    const run = runLength(text, i, '`')
    if (run === length) return i
    i += run - 1
  }
  return -1
}

/** Appends text to the trailing text node, or starts a new one. */
function pushText(nodes: Inline[], value: string): void {
  if (value === '') return
  const last = nodes[nodes.length - 1]
  if (last && last.kind === 'text') last.value += value
  else nodes.push({ kind: 'text', value })
}

/**
 * Parses inline markup.
 *
 * Precedence is code, then links, then strikethrough, then strong, then
 * emphasis. Code comes first because its contents are literal — the single place
 * where a reply can show `**` without it becoming bold.
 */
export function parseInline(text: string): Inline[] {
  const nodes: Inline[] = []
  let index = 0

  while (index < text.length) {
    const char = text[index]
    if (char === undefined) break

    // Escapes: the next character is literal.
    if (char === '\\') {
      const next = text[index + 1]
      if (next !== undefined && /[\\`*_~[\]()#+\-.!>|]/.test(next)) {
        pushText(nodes, next)
        index += 2
        continue
      }
      pushText(nodes, char)
      index += 1
      continue
    }

    if (char === '\n') {
      nodes.push({ kind: 'break' })
      index += 1
      continue
    }

    // --- Code span ---
    if (char === '`') {
      const run = runLength(text, index, '`')
      const end = findCodeSpanEnd(text, index + run, run)
      if (end !== -1) {
        let value = text.slice(index + run, end)
        // One padding space each side is part of the syntax, letting a span hold
        // a leading backtick: `` ` ``.
        if (value.startsWith(' ') && value.endsWith(' ') && value.trim() !== '') {
          value = value.slice(1, -1)
        }
        nodes.push({ kind: 'code', value })
        index = end + run
        continue
      }
      // Unterminated: literal, which is also the mid-stream case.
      pushText(nodes, text.slice(index, index + run))
      index += run
      continue
    }

    // --- Link ---
    if (char === '[') {
      const parsed = parseLink(text, index)
      if (parsed) {
        nodes.push(...parsed.nodes)
        index = parsed.next
        continue
      }
      pushText(nodes, char)
      index += 1
      continue
    }

    // --- Strikethrough, strong, emphasis ---
    const delimiter =
      text.startsWith('~~', index)
        ? '~~'
        : text.startsWith('**', index)
          ? '**'
          : text.startsWith('__', index)
            ? '__'
            : char === '*' || char === '_'
              ? char
              : null

    if (delimiter) {
      const intraWord =
        (delimiter === '_' || delimiter === '__') &&
        isIntraWord(text, index, delimiter.length)
      if (!intraWord) {
        const closer = findCloser(text, index + delimiter.length, delimiter)
        // Reject an empty span so `**` alone stays literal.
        if (closer > index + delimiter.length) {
          const inner = text.slice(index + delimiter.length, closer)
          const children = parseInline(inner)
          const kind =
            delimiter === '~~' ? 'strike' : delimiter.length === 2 ? 'strong' : 'em'
          nodes.push({ kind, children } as Inline)
          index = closer + delimiter.length
          continue
        }
      }
      pushText(nodes, text.slice(index, index + delimiter.length))
      index += delimiter.length
      continue
    }

    pushText(nodes, char)
    index += 1
  }

  // Streaming providers often end a turn with a trailing "\n" (or several),
  // which would otherwise render as a dangling <br> that pushes the last
  // characters onto an extra line/block. Drop any trailing breaks, which carry
  // no visible meaning, while keeping intentional breaks in the middle.
  while (nodes.length > 0 && nodes[nodes.length - 1]?.kind === 'break') {
    nodes.pop()
  }

  return nodes
}

/**
 * Parses `[label](target)` at `start`.
 *
 * A rejected target degrades to the label's text rather than dropping it: the
 * words carry meaning even when the destination is refused, and silently
 * deleting model output would hide what happened.
 */
function parseLink(text: string, start: number): { nodes: Inline[]; next: number } | null {
  // Bracket matching, so `[see [inner]](url)` finds the right closer.
  let depth = 0
  let labelEnd = -1
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (char === '\\') {
      i += 1
      continue
    }
    if (char === '[' && !isEscaped(text, i)) depth += 1
    else if (char === ']' && !isEscaped(text, i)) {
      depth -= 1
      if (depth === 0) {
        labelEnd = i
        break
      }
    }
  }
  if (labelEnd === -1 || text[labelEnd + 1] !== '(') return null

  let parenDepth = 0
  let targetEnd = -1
  for (let i = labelEnd + 1; i < text.length; i += 1) {
    const char = text[i]
    if (char === '\\') {
      i += 1
      continue
    }
    if (char === '(') parenDepth += 1
    else if (char === ')') {
      parenDepth -= 1
      if (parenDepth === 0) {
        targetEnd = i
        break
      }
    }
  }
  if (targetEnd === -1) return null

  const label = text.slice(start + 1, labelEnd)
  const rawTarget = text.slice(labelEnd + 2, targetEnd)
  // Strip an optional title: [x](https://e.com "Title").
  const target = rawTarget.replace(/\s+["'(].*$/s, '').trim()
  const href = safeHref(target)
  const children = parseInline(label)

  if (!href) {
    return { nodes: children.length > 0 ? children : [{ kind: 'text', value: label }], next: targetEnd + 1 }
  }
  return { nodes: [{ kind: 'link', href, children }], next: targetEnd + 1 }
}

// --- Block level --------------------------------------------------------------

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^(\s{0,3})(#{1,6})(\s+|$)/
const HR = /^(\s{0,3})([-*_])(?:\s*\2){2,}\s*$/
const BULLET = /^(\s*)([-*+])(\s+)/
const ORDERED = /^(\s*)(\d{1,9})([.)])(\s+)/
const QUOTE = /^(\s{0,3})>\s?/

/** A recognized list marker on one line. */
interface Marker {
  indent: number
  ordered: boolean
  /** Column where the item's own content starts, for dedenting continuations. */
  contentIndent: number
  rest: string
  start: number
}

function matchMarker(line: string): Marker | null {
  const bullet = BULLET.exec(line)
  if (bullet) {
    const [, indent = '', , spaces = ''] = bullet
    return {
      indent: indent.length,
      ordered: false,
      contentIndent: indent.length + 1 + spaces.length,
      rest: line.slice(bullet[0].length),
      start: 1,
    }
  }
  const ordered = ORDERED.exec(line)
  if (ordered) {
    const [, indent = '', digits = '1', , spaces = ''] = ordered
    return {
      indent: indent.length,
      ordered: true,
      contentIndent: indent.length + digits.length + 1 + spaces.length,
      rest: line.slice(ordered[0].length),
      start: Number(digits),
    }
  }
  return null
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === ''
}

/** True when a line looks like a table delimiter row: `|---|:--:|`. */
function isTableDelimiter(line: string | undefined): boolean {
  if (line === undefined) return false
  const trimmed = line.trim()
  if (!trimmed.includes('-')) return false
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(trimmed)
}

/** Splits a table row on unescaped pipes, dropping the edge separators. */
function splitRow(line: string): string[] {
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '\\' && line[i + 1] === '|') {
      current += '|'
      i += 1
      continue
    }
    if (char === '|') {
      cells.push(current)
      current = ''
      continue
    }
    current += char
  }
  cells.push(current)
  // A leading or trailing pipe produces an empty edge cell that is syntax.
  if (cells.length > 0 && cells[0]?.trim() === '') cells.shift()
  if (cells.length > 0 && cells[cells.length - 1]?.trim() === '') cells.pop()
  return cells.map((cell) => cell.trim())
}

function parseAlign(line: string): Align[] {
  return splitRow(line.trim()).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

/**
 * Parses Markdown into blocks.
 *
 * Safe to call on a partial document: see the module note on streaming.
 */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  return parseBlocks(lines)
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (line === undefined) break

    if (isBlank(line)) {
      i += 1
      continue
    }

    // --- Fenced code ---
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[2] ?? '```'
      const lang = (fence[3] ?? '').trim()
      const body: string[] = []
      let closed = false
      i += 1
      while (i < lines.length) {
        const current = lines[i]
        if (current === undefined) break
        // A closing fence is the same character, at least as long, nothing else.
        const closer = new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`)
        if (closer.test(current)) {
          closed = true
          i += 1
          break
        }
        body.push(current)
        i += 1
      }
      blocks.push({ kind: 'code', lang, value: body.join('\n'), closed })
      continue
    }

    // --- Heading ---
    const heading = HEADING.exec(line)
    if (heading) {
      const level = (heading[2] ?? '#').length
      // Trailing #s are decoration in ATX headings.
      const content = line.slice(heading[0].length).replace(/\s+#+\s*$/, '')
      blocks.push({ kind: 'heading', level, children: parseInline(content.trim()) })
      i += 1
      continue
    }

    // --- Thematic break (before list, since `---` also matches a bullet) ---
    if (HR.test(line)) {
      blocks.push({ kind: 'hr' })
      i += 1
      continue
    }

    // --- Blockquote ---
    if (QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length) {
        const current = lines[i]
        if (current === undefined) break
        if (QUOTE.test(current)) {
          inner.push(current.replace(QUOTE, ''))
          i += 1
          continue
        }
        // A blank line ends the quote; lazy continuation is not supported
        // because it reads ambiguously in a narrow panel.
        if (isBlank(current)) break
        break
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(inner) })
      continue
    }

    // --- Table ---
    if (line.includes('|') && isTableDelimiter(lines[i + 1])) {
      const head = splitRow(line.trim()).map((cell) => parseInline(cell))
      const align = parseAlign(lines[i + 1] ?? '')
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length) {
        const current = lines[i]
        if (current === undefined || isBlank(current) || !current.includes('|')) break
        rows.push(splitRow(current.trim()).map((cell) => parseInline(cell)))
        i += 1
      }
      blocks.push({ kind: 'table', head, align, rows })
      continue
    }

    // --- List ---
    const marker = matchMarker(line)
    if (marker) {
      const parsed = parseList(lines, i, marker)
      blocks.push(parsed.block)
      i = parsed.next
      continue
    }

    // --- Paragraph ---
    const paragraph: string[] = []
    while (i < lines.length) {
      const current = lines[i]
      if (current === undefined || isBlank(current)) break
      // Any construct that can interrupt a paragraph ends it.
      if (
        FENCE.test(current) ||
        HEADING.test(current) ||
        HR.test(current) ||
        QUOTE.test(current) ||
        matchMarker(current) ||
        (current.includes('|') && isTableDelimiter(lines[i + 1]))
      ) {
        break
      }
      paragraph.push(current.trim())
      i += 1
    }
    if (paragraph.length > 0) {
      /**
       * Single newlines become real line breaks.
       *
       * Strict Markdown folds them into spaces, but an assistant writing into a
       * chat panel uses one newline to mean one line break — collapsing them
       * runs address blocks and short lists of notes together.
       */
      blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n')) })
    }
  }

  return blocks
}

/** Collects consecutive items at one indent into a list block. */
function parseList(
  lines: string[],
  start: number,
  first: Marker,
): { block: Block; next: number } {
  const items: ListItem[] = []
  let i = start

  while (i < lines.length) {
    const line = lines[i]
    if (line === undefined) break

    const marker = matchMarker(line)
    // A different indent or a switch between bullets and numbers starts a
    // different list, which the caller will pick up.
    if (!marker || marker.indent !== first.indent || marker.ordered !== first.ordered) break

    const itemLines: string[] = [marker.rest]
    i += 1

    // Continuation: deeper-indented lines, plus blank lines that are followed by
    // more of this item. Trailing blanks are left for the caller.
    let pendingBlanks = 0
    while (i < lines.length) {
      const current = lines[i]
      if (current === undefined) break

      if (isBlank(current)) {
        pendingBlanks += 1
        i += 1
        continue
      }

      const indent = current.length - current.trimStart().length
      if (indent >= marker.contentIndent) {
        for (let b = 0; b < pendingBlanks; b += 1) itemLines.push('')
        pendingBlanks = 0
        itemLines.push(current.slice(marker.contentIndent))
        i += 1
        continue
      }

      // A sibling marker after a blank line stays in this list, so the item ends
      // here rather than absorbing it.
      break
    }
    i -= pendingBlanks

    items.push({ blocks: parseBlocks(itemLines) })
  }

  return {
    block: { kind: 'list', ordered: first.ordered, start: first.start, items },
    next: i,
  }
}
