import { describe, expect, it } from 'vitest'
import {
  buildAnswerFilename,
  slugForFilename,
  toMarkdownText,
  toPlainText,
  toPrintableHtml,
} from '../src/lib/export-answer'

describe('slugForFilename', () => {
  it('keeps unicode and trims', () => {
    expect(slugForFilename('  今天 的分析  ')).toBe('今天 的分析')
  })
  it('replaces filesystem-hostile chars', () => {
    expect(slugForFilename('a/b\\c:*d')).toBe('a-b-c-d')
  })
  it('collapses whitespace', () => {
    expect(slugForFilename('  a   b\tc  ')).toBe('a b c')
  })
  it('returns empty for blank', () => {
    expect(slugForFilename('')).toBe('')
    expect(slugForFilename('   . -. ')).toBe('')
  })
})

describe('buildAnswerFilename', () => {
  it('produces title + timestamp + extension', () => {
    const name = buildAnswerFilename('md', '我的总结', '对话', 1_700_000_000_000)
    expect(name).toMatch(/^我的总结-/)
    expect(name.endsWith('.md')).toBe(true)
    const stamp = new Date(1_700_000_000_000).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    expect(name).toContain(`-${stamp}.`)
  })
  it('falls back to fallbackSlug when title yields nothing', () => {
    expect(buildAnswerFilename('txt', '', '对话', 1)).toMatch(/^对话-\d{4}.*\.txt$/)
  })
  it('uses .html extension for html format', () => {
    expect(buildAnswerFilename('html', 'x', 'c', 1)).toMatch(/\.html$/)
  })
})

describe('toMarkdownText', () => {
  it('keeps content and guarantees a trailing newline', () => {
    expect(toMarkdownText('# Hi')).toBe('# Hi\n')
    expect(toMarkdownText('# Hi\n')).toBe('# Hi\n')
  })
  it('normalises CRLF', () => {
    expect(toMarkdownText('a\r\nb')).toBe('a\nb\n')
  })
})

describe('toPlainText', () => {
  it('strips markdown syntax but keeps text', () => {
    const md = `# Title

- *one*
- **two**

[link](https://x.test) tail

\`\`\`js
const a = 1
\`\`\`
`
    const plain = toPlainText(md)
    expect(plain).toContain('Title')
    expect(plain).toContain('one')
    expect(plain).toContain('two')
    expect(plain).toContain('link')
    expect(plain).toContain('tail')
    expect(plain).toContain('const a = 1')
    // No leftover markdown syntax markers.
    expect(plain).not.toMatch(/\*\*/)
  })

  it('handles empty input', () => {
    expect(toPlainText('')).toBe('')
  })
})

describe('toPrintableHtml', () => {
  it('wraps content into a full html document with escaped text', () => {
    const html = toPrintableHtml('# Hello & <bye>', '标题')
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('<title>标题</title>')
    expect(html).toContain('<h1>Hello &amp; &lt;bye&gt;</h1>')
  })
  it('escapes code blocks', () => {
    const html = toPrintableHtml('```\n<plain>\n```', 'x')
    expect(html).toContain('<pre><code>&lt;plain&gt;</code></pre>')
  })
})