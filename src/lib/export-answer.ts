/**
 * Format helpers for exporting assistant answers to downloadable files.
 *
 * Kept free of DOM globals (`window`/`document`) so the conversion functions
 * remain unit-testable in plain Node. The download driver itself touches DOM
 * only through the thin `downloadBlob` wrapper, which is guarded at runtime.
 *
 * @module lib/export-answer
 */
import { parseMarkdown, type Block, type Inline, type ListItem } from './markdown'

export type AnswerFormat = 'md' | 'txt' | 'html'

/** Returns a filename-safe slug derived from a conversation title. */
export function slugForFilename(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ''
  // Swap any filesystem-hostile chars for dashes and strip leading/trailing
  // punctuation. Keep Unicode letters (Chinese, …) intact — modern systems
  // accept UTF-8 filenames and this matters more than ASCII-only short names.
  const cleaned = trimmed
    .replace(/\s+/g, ' ')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/^[\s-.]+|[\s-.]+$/g, '')
  return cleaned.slice(0, 80)
}

/**
 * Builds the full filename for an answer download, including timestamp and
 * sanitised conversation title (when provided).
 */
export function buildAnswerFilename(
  format: AnswerFormat,
  title: string | undefined,
  fallbackSlug = 'conversation',
  at = Date.now(),
): string {
  const safeTitle = slugForFilename(title ?? '') || fallbackSlug
  const stamp = new Date(at).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const ext = format === 'html' ? 'html' : format
  return `${safeTitle}-${stamp}.${ext}`
}

/** Normalised Markdown output — basically a trailing-newline guard. */
export function toMarkdownText(text: string): string {
  const trimmed = text.replace(/\r\n/g, '\n')
  return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`
}

// --- Plain text walker ---------------------------------------------------

function inlineToText(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
        case 'code':
          return node.value
        case 'strong':
        case 'em':
        case 'strike':
          return inlineToText(node.children)
        case 'link':
          // Prefer link text; keep URL in parens only if it differs, so "read
          // more (https://…)" is retained without duplicating plain URLs.
          const label = inlineToText(node.children)
          try {
            if (node.href && label !== node.href) return `${label} (${node.href})`
          } catch {
            /* ignore */
          }
          return label
        case 'break':
          return '\n'
        default:
          return ''
      }
    })
    .join('')
}

function itemsToText(items: ListItem[], ordered: boolean, start: number, indent = ''): string {
  const lines: string[] = []
  items.forEach((item, index) => {
    const bullet = ordered ? `${start + index}. ` : '• '
    const inner = blocksToText(item.blocks, `${indent}  `)
    const firstBreak = inner.indexOf('\n\n')
    const firstLine = (firstBreak === -1 ? inner : inner.slice(0, firstBreak)).trimStart()
    const rest = firstBreak === -1 ? '' : inner.slice(firstBreak + 2)
    lines.push(`${indent}${bullet}${firstLine}`)
    if (rest) lines.push(rest)
  })
  return lines.join('\n')
}

function blocksToText(blocks: Block[], indent = ''): string {
  const out: string[] = []
  for (const block of blocks) {
    switch (block.kind) {
      case 'paragraph':
        out.push(`${indent}${inlineToText(block.children).replace(/\n$/, '')}`)
        break
      case 'heading': {
        const body = inlineToText(block.children).trim()
        if (body) out.push(`${indent}${body}`)
        break
      }
      case 'code': {
        const body = block.value.replace(/\n$/, '')
        const rendered = body
          .split('\n')
          .map((l) => `${indent}  ${l}`)
          .join('\n')
        out.push(rendered)
        break
      }
      case 'list':
        out.push(itemsToText(block.items, block.ordered, block.start, indent))
        break
      case 'quote': {
        const inner = blocksToText(block.blocks, `${indent}> `)
        out.push(inner)
        break
      }
      case 'hr':
        out.push(`${indent}—`)
        break
      case 'table': {
        // Tables degrade to tab-separated lines; this is still plain text and
        // avoids producing empty lines for empty tables.
        const rowsToRender = [block.head, ...block.rows]
        for (const row of rowsToRender) {
          out.push(row.map((cell) => inlineToText(cell).replace(/\t/g, ' ')).join('\t'))
        }
        break
      }
    }
  }
  return out.join('\n\n')
}

/** Strips Markdown formatting and returns a readable plain text dump. */
export function toPlainText(mdText: string): string {
  if (!mdText) return ''
  const blocks = parseMarkdown(mdText)
  const rendered = blocksToText(blocks)
  const collapsed = rendered.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return `${collapsed}\n`
}

// --- Printable HTML -------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function inlineToHtml(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
          return escapeHtml(node.value)
        case 'code':
          return `<code>${escapeHtml(node.value)}</code>`
        case 'strong':
          return `<strong>${inlineToHtml(node.children)}</strong>`
        case 'em':
          return `<em>${inlineToHtml(node.children)}</em>`
        case 'strike':
          return `<del>${inlineToHtml(node.children)}</del>`
        case 'link': {
          const label = inlineToHtml(node.children)
          const href = escapeHtml(node.href || '')
          // Narrow allowlist is enforced by markdown parser already; for the
          // exported file we still open links in a new tab.
          return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
        }
        case 'break':
          return '<br />'
        default:
          return ''
      }
    })
    .join('')
}

function listItemsToHtml(items: ListItem[], ordered: boolean, start: number): string {
  const tag = ordered ? 'ol' : 'ul'
  const startAttr = ordered && start !== 1 ? ` start="${start}"` : ''
  const inner = items
    .map((item) => `<li>${blocksToHtml(item.blocks)}</li>`)
    .join('')
  return `<${tag}${startAttr}>${inner}</${tag}>`
}

function alignAttr(align: 'left' | 'center' | 'right' | null): string {
  if (!align) return ''
  return ` align="${align}"`
}

function blocksToHtml(blocks: Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case 'paragraph':
          return `<p>${inlineToHtml(block.children)}</p>`
        case 'heading':
          return `<h${Math.min(6, Math.max(1, block.level))}>${inlineToHtml(block.children)}</h${Math.min(6, Math.max(1, block.level))}>`
        case 'code': {
          const cls = block.lang ? ` class="language-${escapeHtml(block.lang)}"` : ''
          return `<pre><code${cls}>${escapeHtml(block.value)}</code></pre>`
        }
        case 'list':
          return listItemsToHtml(block.items, block.ordered, block.start)
        case 'quote':
          return `<blockquote>${blocksToHtml(block.blocks)}</blockquote>`
        case 'hr':
          return '<hr />'
        case 'table': {
          const thead = `<thead><tr>${block.head
            .map((cell, idx) => `<th${alignAttr(block.align[idx] ?? null)}>${inlineToHtml(cell)}</th>`)
            .join('')}</tr></thead>`
          const tbody = `<tbody>${block.rows
            .map((row) => `<tr>${row
              .map((cell, idx) => `<td${alignAttr(block.align[idx] ?? null)}>${inlineToHtml(cell)}</td>`)
              .join('')}</tr>`)
            .join('')}</tbody>`
          return `<table>${thead}${tbody}</table>`
        }
        default:
          return ''
      }
    })
    .join('\n')
}

/**
 * Returns a full standalone HTML document suitable for printing (or for the
 * user to convert to PDF via their browser's print dialog).
 */
export function toPrintableHtml(mdText: string, title?: string): string {
  const blocks = parseMarkdown(mdText)
  const body = blocksToHtml(blocks)
  const docTitle = escapeHtml(title || 'Answer')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${docTitle}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { color-scheme: light dark; }
    html, body { background: #ffffff; color: #111827; }
    body {
      max-width: 760px;
      margin: 40px auto;
      padding: 20px 28px;
      font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    h1,h2,h3,h4,h5,h6 { line-height: 1.25; margin: 1.4em 0 0.6em; }
    p, blockquote, ul, ol, table, pre { margin: 0 0 1em; }
    code {
      font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      background: rgba(17,24,39,0.06);
      padding: 1px 4px;
      border-radius: 4px;
    }
    pre {
      background: rgba(17,24,39,0.04);
      border: 1px solid rgba(17,24,39,0.08);
      padding: 12px 14px;
      border-radius: 8px;
      overflow-x: auto;
    }
    pre code { background: transparent; padding: 0; border-radius: 0; }
    blockquote {
      margin-left: 0;
      padding: 2px 14px;
      color: #374151;
      border-left: 4px solid rgba(17,24,39,0.2);
      background: rgba(17,24,39,0.03);
      border-radius: 0 6px 6px 0;
    }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid rgba(17,24,39,0.12); padding: 6px 10px; vertical-align: top; }
    th { background: rgba(17,24,39,0.04); text-align: left; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    hr { border: none; border-top: 1px solid rgba(17,24,39,0.12); margin: 1.8em 0; }
    @media (prefers-color-scheme: dark) {
      html, body { background: #0b1220; color: #e5e7eb; }
      code { background: rgba(255,255,255,0.08); }
      pre  { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.12); }
      blockquote { color: #d1d5db; border-left-color: rgba(255,255,255,0.25); background: rgba(255,255,255,0.04); }
      th, td { border-color: rgba(255,255,255,0.15); }
      th { background: rgba(255,255,255,0.05); }
      a { color: #60a5fa; }
      hr { border-top-color: rgba(255,255,255,0.15); }
    }
    @media print {
      body { margin: 0; max-width: none; }
      a { color: inherit; text-decoration: underline; }
    }
  </style>
</head>
<body>
${body}
</body>
</html>
`
}

/**
 * Triggers a download using Blob + Object URL + a temporary anchor.
 *
 * Safe in browser contexts only; guarded to no-op when the DOM is missing so
 * callers in tests don't need to stub it out.
 */
export function downloadBlob(content: string, mime: string, filename: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return
  try {
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    // Clean up: allow the browser to finalise the download before revoking.
    window.setTimeout(() => {
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }, 0)
  } catch {
    /* ignore — user can still manually copy from the UI */
  }
}

/** MIME -> extension picker used by callers to keep one canonical table. */
export const MIME_FOR_FORMAT: Record<AnswerFormat, string> = {
  md: 'text/markdown;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
  html: 'text/html;charset=utf-8',
}

/** One helper that converts + downloads in a single call. */
export function downloadAnswer(params: {
  text: string
  format: AnswerFormat
  title?: string
  fallbackSlug?: string
  at?: number
}): string {
  const { text, format, title, fallbackSlug, at } = params
  const filename = buildAnswerFilename(format, title, fallbackSlug, at)
  let body = ''
  switch (format) {
    case 'md':
      body = toMarkdownText(text)
      break
    case 'txt':
      body = toPlainText(text)
      break
    case 'html':
      body = toPrintableHtml(text, title)
      break
  }
  downloadBlob(body, MIME_FOR_FORMAT[format], filename)
  return filename
}
