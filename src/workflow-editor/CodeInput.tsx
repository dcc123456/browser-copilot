/**
 * CodeInput: a highlighted JavaScript code editor.
 *
 * Plain `<textarea>` semantics (native copy/paste, selection, undo) with a
 * syntax-highlighted `<pre>` rendered behind it. The textarea draws a visible
 * caret but transparent text so the highlight shows through; scroll and line
 * metrics are identical for both layers so tokens stay aligned.
 *
 * No external highlighter dependency — the tokenizer is deliberately small and
 * good enough for workflow snippets (keywords, strings, comments, numbers, and
 * `{{variable}}` tokens).
 *
 * @module workflow-editor/CodeInput
 */
import { useMemo, useRef } from 'react'

const KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function',
  'if', 'import', 'in', 'instanceof', 'let', 'new', 'return', 'super', 'switch',
  'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'await', 'async', 'true', 'false', 'null', 'undefined', 'of',
])

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/ /g, '\u00a0')
}

interface HighlightedLine {
  html: string
}

/** Tokenizes one line of JavaScript into a highlighted HTML string. */
function highlightLine(line: string): string {
  const out: string[] = []

  // Split line into: comments, strings, tokens/variables, and the rest.
  const re = /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\{\{\s*[\w.-]+\s*\}\}|([A-Za-z_$][\w$]*)|(\b\d+(?:\.\d+)?\b)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = re.exec(line)) !== null) {
    if (match.index > lastIndex) {
      out.push(escapeHtml(line.slice(lastIndex, match.index)))
    }
    const [whole, comment, strng, token, number] = match
    if (comment !== undefined) {
      out.push(`<span class="tok-comment">${escapeHtml(whole)}</span>`)
    } else if (strng !== undefined) {
      out.push(`<span class="tok-string">${escapeHtml(whole)}</span>`)
    } else if (token !== undefined) {
      out.push(
        `<span class="${KEYWORDS.has(token) ? 'tok-keyword' : 'tok-name'}">${escapeHtml(whole)}</span>`,
      )
    } else if (number !== undefined) {
      out.push(`<span class="tok-number">${escapeHtml(whole)}</span>`)
    } else {
      out.push(`<span class="tok-token">${escapeHtml(whole)}</span>`)
    }
    lastIndex = re.lastIndex
  }
  if (lastIndex < line.length) {
    out.push(escapeHtml(line.slice(lastIndex)))
  }
  return out.join('')
}

export default function CodeInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  const preRef = useRef<HTMLPreElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const highlighted = useMemo(
    () => value.split('\n').map((line): HighlightedLine => ({ html: highlightLine(line) || '\u00a0' })),
    [value],
  )

  const syncScroll = (): void => {
    if (preRef.current && taRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop
      preRef.current.scrollLeft = taRef.current.scrollLeft
    }
  }

  return (
    <div className="code-input">
      <pre ref={preRef} className="code-highlight" aria-hidden="true">
        {highlighted.map((line, index) => (
          <div key={index} dangerouslySetInnerHTML={{ __html: line.html }} />
        ))}
      </pre>
      <textarea
        ref={taRef}
        className="code-write"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onInput={syncScroll}
        onScroll={syncScroll}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}