/**
 * Renders the Markdown tree from `lib/markdown` as React elements.
 *
 * Every node becomes a React element or a text node — there is no
 * `dangerouslySetInnerHTML` anywhere in this file, and no HTML string is ever
 * built. Assistant text is untrusted (the model may have just read a hostile
 * page) and this panel is privileged (it can reach `chrome.storage`, where API
 * keys live), so safety is structural rather than a matter of sanitizing
 * correctly. See the note at the top of `lib/markdown.ts`.
 *
 * @module sidepanel/Markdown
 */
import { memo, useState, type ReactNode } from 'react'
import { parseMarkdown, type Block, type Inline } from '../lib/markdown'
import { useT } from './i18n'

function renderInline(nodes: Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`
    switch (node.kind) {
      case 'text':
        return node.value
      case 'break':
        return <br key={key} />
      case 'code':
        return (
          <code className="md-code-inline" key={key}>
            {node.value}
          </code>
        )
      case 'strong':
        return <strong key={key}>{renderInline(node.children, key)}</strong>
      case 'em':
        return <em key={key}>{renderInline(node.children, key)}</em>
      case 'strike':
        return <del key={key}>{renderInline(node.children, key)}</del>
      case 'link':
        return (
          <a
            className="md-link"
            href={node.href}
            key={key}
            // A side panel is not a browsing context: opening in place would
            // replace the panel itself and lose the conversation.
            target="_blank"
            // noreferrer as well as noopener: the opened page has no business
            // learning that an extension panel linked to it.
            rel="noopener noreferrer"
          >
            {renderInline(node.children, key)}
          </a>
        )
    }
  })
}

/**
 * A fenced code block with a copy button.
 *
 * Copying is the point of showing code in a chat panel — an assistant that emits
 * a command the user must retype by hand has only half-helped.
 */
function CodeBlock({ lang, value, closed }: { lang: string; value: string; closed: boolean }) {
  const t = useT()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copy = (): void => {
    void navigator.clipboard
      .writeText(value)
      .then(() => setState('copied'))
      .catch(() => {
        // Clipboard access can be refused (an unfocused document, or a policy
        // that blocks it). Saying so is better than a click that appears to do
        // nothing — the text stays selectable, so the user can still copy it by
        // hand once they know the button did not work.
        setState('failed')
      })
      .finally(() => {
        // Reverts on its own: a button stuck on "Copied" tells the user nothing
        // about whether a later click worked.
        window.setTimeout(() => setState('idle'), 1400)
      })
  }

  const label = state === 'copied' ? t.mdCopied : state === 'failed' ? t.mdCopyFailed : t.mdCopy

  return (
    <div className="md-codeblock" data-streaming={!closed}>
      <div className="md-codeblock-head">
        <span className="md-codeblock-lang">{lang || t.mdCodePlain}</span>
        <button className="md-copy" data-state={state} onClick={copy} type="button">
          {label}
        </button>
      </div>
      <pre>
        <code>{value}</code>
      </pre>
    </div>
  )
}

function renderBlocks(blocks: Block[], keyPrefix: string): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}-${index}`
    switch (block.kind) {
      case 'paragraph':
        return (
          <p className="md-p" key={key}>
            {renderInline(block.children, key)}
          </p>
        )

      case 'heading': {
        // Headings are styled by level but rendered as divs with an aria role:
        // an h1 from a model reply would otherwise claim to be the panel's
        // top-level heading and disrupt screen-reader navigation.
        return (
          <div
            aria-level={block.level}
            className="md-heading"
            data-level={block.level}
            key={key}
            role="heading"
          >
            {renderInline(block.children, key)}
          </div>
        )
      }

      case 'code':
        return <CodeBlock closed={block.closed} key={key} lang={block.lang} value={block.value} />

      case 'list': {
        const items = block.items.map((item, itemIndex) => (
          <li key={`${key}-i${itemIndex}`}>{renderBlocks(item.blocks, `${key}-i${itemIndex}`)}</li>
        ))
        return block.ordered ? (
          <ol className="md-list" key={key} start={block.start}>
            {items}
          </ol>
        ) : (
          <ul className="md-list" key={key}>
            {items}
          </ul>
        )
      }

      case 'quote':
        return (
          <blockquote className="md-quote" key={key}>
            {renderBlocks(block.blocks, key)}
          </blockquote>
        )

      case 'hr':
        return <hr className="md-hr" key={key} />

      case 'table':
        return (
          // Wrapped so a wide table scrolls itself instead of stretching the
          // panel, which has no horizontal room to give.
          <div className="md-table-wrap" key={key}>
            <table className="md-table">
              <thead>
                <tr>
                  {block.head.map((cell, cellIndex) => (
                    <th
                      key={`${key}-h${cellIndex}`}
                      style={
                        block.align[cellIndex] ? { textAlign: block.align[cellIndex]! } : undefined
                      }
                    >
                      {renderInline(cell, `${key}-h${cellIndex}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={`${key}-r${rowIndex}`}>
                    {row.map((cell, cellIndex) => (
                      <td
                        key={`${key}-r${rowIndex}c${cellIndex}`}
                        style={
                          block.align[cellIndex]
                            ? { textAlign: block.align[cellIndex]! }
                            : undefined
                        }
                      >
                        {renderInline(cell, `${key}-r${rowIndex}c${cellIndex}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
    }
  })
}

/**
 * Renders Markdown text.
 *
 * Memoized because a streaming reply re-renders on every token: without this,
 * each delta would reparse and rebuild every earlier message in the transcript.
 */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="md">{renderBlocks(parseMarkdown(text), 'b')}</div>
})

export default Markdown
