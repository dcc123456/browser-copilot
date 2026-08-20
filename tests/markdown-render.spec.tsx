/**
 * Render-level tests for Markdown replies.
 *
 * The parser tests in `markdown.spec.ts` assert on the tree; these assert on the
 * HTML that actually reaches the DOM. That distinction matters for the security
 * claim: a correct tree rendered carelessly could still inject markup, so the
 * guarantee is verified where it is finally observable.
 *
 * Rendered with `react-dom/server` so no DOM environment or extra dependency is
 * needed — the tests stay in the same `environment: node` suite as everything
 * else.
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import Markdown from '../src/sidepanel/Markdown'

function render(text: string): string {
  return renderToStaticMarkup(createElement(Markdown, { text }))
}

describe('Markdown rendering · structure', () => {
  it('renders emphasis as real elements', () => {
    const html = render('**bold** and *italic* and ~~gone~~')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<del>gone</del>')
  })

  it('renders headings with a level attribute and an aria role', () => {
    const html = render('## Section')
    expect(html).toContain('data-level="2"')
    expect(html).toContain('role="heading"')
    // Not a real <h2>: a heading from a model reply must not claim a place in
    // the panel's own document outline.
    expect(html).not.toContain('<h2')
  })

  it('renders lists, preserving an ordered list start', () => {
    expect(render('- a\n- b')).toContain('<ul')
    const ordered = render('3. three\n4. four')
    expect(ordered).toContain('<ol')
    expect(ordered).toContain('start="3"')
  })

  it('renders a table with alignment styles', () => {
    const html = render('| a | b |\n|:--|--:|\n| 1 | 2 |')
    expect(html).toContain('<table')
    expect(html).toContain('<th')
    expect(html).toContain('text-align:left')
    expect(html).toContain('text-align:right')
  })

  it('renders a code block with its language label and a copy button', () => {
    const html = render('```ts\nconst a = 1\n```')
    expect(html).toContain('<pre>')
    expect(html).toContain('ts')
    expect(html).toContain('md-copy')
  })

  it('marks an unclosed fence as still streaming', () => {
    expect(render('```js\nlet x')).toContain('data-streaming="true"')
    expect(render('```js\nlet x\n```')).toContain('data-streaming="false"')
  })

  it('renders a blockquote and a thematic break', () => {
    expect(render('> quoted')).toContain('<blockquote')
    expect(render('---')).toContain('<hr')
  })
})

describe('Markdown rendering · link safety', () => {
  it('renders a safe link with noopener and noreferrer', () => {
    const html = render('[docs](https://example.com)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('never emits an href for a script-bearing target', () => {
    for (const bad of [
      '[x](javascript:alert(1))',
      '[x](JaVaScRiPt:alert(1))',
      '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
      '[x](vbscript:msgbox(1))',
      '[x](java\tscript:alert(1))',
    ]) {
      const html = render(bad)
      expect(html).not.toContain('href')
      expect(html).not.toMatch(/javascript:/i)
      expect(html).not.toMatch(/vbscript:/i)
      expect(html).not.toMatch(/data:text\/html/i)
      // The label survives; only the destination is refused.
      expect(html).toContain('x')
    }
  })
})

describe('Markdown rendering · injection', () => {
  /**
   * The panel can read `chrome.storage`, where the user's API keys live, and
   * assistant text is untrusted because the model may have just read a hostile
   * page. So script must never survive into the markup, however it is smuggled.
   */
  it('escapes HTML in ordinary text', () => {
    const html = render('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes an event-handler attribute payload', () => {
    const html = render('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('escapes HTML inside code spans and code blocks', () => {
    expect(render('`<script>alert(1)</script>`')).not.toContain('<script>')
    expect(render('```\n<script>alert(1)</script>\n```')).not.toContain('<script>')
  })

  it('escapes HTML inside every container', () => {
    for (const input of [
      '# <script>alert(1)</script>',
      '- <script>alert(1)</script>',
      '> <script>alert(1)</script>',
      '| a |\n|---|\n| <script>alert(1)</script> |',
      '**<script>alert(1)</script>**',
      '[<script>alert(1)</script>](https://example.com)',
    ]) {
      const html = render(input)
      expect(html).not.toContain('<script>')
      expect(html).not.toContain('</script>')
    }
  })

  it('does not let a closing tag break out of an attribute', () => {
    const html = render('[x](https://example.com/"><script>alert(1)</script>)')
    expect(html).not.toContain('<script>')
  })
})

describe('Markdown rendering · robustness', () => {
  it('renders every prefix of a rich reply without throwing', () => {
    // The component re-renders on each streamed token, so a prefix that throws
    // would blank the panel mid-answer.
    const document = [
      '# Title',
      '',
      'Text with **bold**, `code`, and [a link](https://example.com).',
      '',
      '- one',
      '  - nested',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      '> quote',
      '',
      '---',
    ].join('\n')

    for (let i = 0; i <= document.length; i += 1) {
      expect(() => render(document.slice(0, i))).not.toThrow()
    }
  })

  it('renders empty and whitespace-only text without throwing', () => {
    expect(() => render('')).not.toThrow()
    expect(() => render('\n\n  \n')).not.toThrow()
  })

  it('renders delimiter soup without throwing', () => {
    for (const input of ['*'.repeat(200), '['.repeat(200), '`'.repeat(200), '**[`*_~']) {
      expect(() => render(input)).not.toThrow()
    }
  })

  it('preserves CJK text intact', () => {
    const html = render('**火山方舟** 与 `简体中文`')
    expect(html).toContain('火山方舟')
    expect(html).toContain('简体中文')
  })
})
