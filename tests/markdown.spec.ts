import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown, safeHref, type Block, type Inline } from '../src/lib/markdown'

/** Flattens a tree back to its visible text, for asserting on structure cheaply. */
function textOf(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
        case 'code':
          return node.value
        case 'break':
          return '\n'
        default:
          return textOf(node.children)
      }
    })
    .join('')
}

function kinds(nodes: Inline[]): string[] {
  return nodes.map((node) => node.kind)
}

describe('safeHref', () => {
  it('accepts the schemes a chat reply legitimately needs', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com')
    expect(safeHref('http://localhost:3000/x')).toBe('http://localhost:3000/x')
    expect(safeHref('mailto:a@b.com')).toBe('mailto:a@b.com')
    expect(safeHref('tel:+123')).toBe('tel:+123')
  })

  /**
   * The panel can reach `chrome.storage`, where API keys live, so a link that
   * executes script is a credential-disclosure bug, not a rendering glitch.
   */
  it('rejects script-bearing schemes regardless of casing or padding', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'JAVASCRIPT:alert(1)',
      '  javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'chrome://settings',
    ]) {
      expect(safeHref(bad)).toBeNull()
    }
  })

  it('rejects control characters instead of stripping them', () => {
    // Browsers ignore these when resolving a URL, so `java\tscript:` would pass
    // a naive scheme test and still execute. Rejecting is the only safe answer.
    expect(safeHref('java\tscript:alert(1)')).toBeNull()
    expect(safeHref('java\nscript:alert(1)')).toBeNull()
    expect(safeHref('java\u0000script:alert(1)')).toBeNull()
    expect(safeHref('https://example.com\u0000')).toBeNull()
  })

  it('rejects relative and scheme-relative targets', () => {
    // A side panel has no meaningful base document; these could only resolve
    // against the extension's own origin.
    expect(safeHref('//evil.com')).toBeNull()
    expect(safeHref('/settings')).toBeNull()
    expect(safeHref('./x')).toBeNull()
    expect(safeHref('')).toBeNull()
  })
})

describe('parseInline · emphasis', () => {
  it('parses strong and emphasis', () => {
    expect(kinds(parseInline('**bold**'))).toEqual(['strong'])
    expect(kinds(parseInline('*italic*'))).toEqual(['em'])
    expect(kinds(parseInline('__bold__'))).toEqual(['strong'])
    expect(kinds(parseInline('~~gone~~'))).toEqual(['strike'])
  })

  it('nests emphasis inside strong', () => {
    const nodes = parseInline('**bold *both* end**')
    expect(nodes).toHaveLength(1)
    const strong = nodes[0]!
    expect(strong.kind).toBe('strong')
    if (strong.kind !== 'strong') throw new Error('unreachable')
    expect(kinds(strong.children)).toContain('em')
    expect(textOf(nodes)).toBe('bold both end')
  })

  /**
   * Identifiers with underscores are constant in technical replies
   * (`max_tokens`, `SCHEMA_VERSION`); treating those as emphasis both mangles
   * the name and eats the underscores.
   */
  it('leaves intra-word underscores alone', () => {
    expect(kinds(parseInline('max_tokens_here'))).toEqual(['text'])
    expect(textOf(parseInline('max_tokens_here'))).toBe('max_tokens_here')
    expect(textOf(parseInline('SCHEMA_VERSION'))).toBe('SCHEMA_VERSION')
  })

  it('still treats asterisks as emphasis inside a word', () => {
    expect(kinds(parseInline('a*b*c'))).toContain('em')
  })

  it('keeps an unterminated delimiter literal', () => {
    // This is every streaming reply mid-token: guessing at a span that may never
    // close would make text flicker between bold and plain as it arrives.
    expect(textOf(parseInline('**not closed'))).toBe('**not closed')
    expect(kinds(parseInline('**not closed'))).toEqual(['text'])
  })

  it('keeps an empty delimiter pair literal', () => {
    expect(textOf(parseInline('****'))).toBe('****')
  })

  it('honours backslash escapes', () => {
    expect(textOf(parseInline('\\*not italic\\*'))).toBe('*not italic*')
    expect(kinds(parseInline('\\*not italic\\*'))).toEqual(['text'])
  })
})

describe('parseInline · code spans', () => {
  it('parses a code span and keeps its content literal', () => {
    const nodes = parseInline('use `a ** b` here')
    expect(kinds(nodes)).toEqual(['text', 'code', 'text'])
    const code = nodes[1]!
    if (code.kind !== 'code') throw new Error('unreachable')
    // The whole point: markup inside code is not markup.
    expect(code.value).toBe('a ** b')
  })

  it('supports doubled backticks so a span can contain a backtick', () => {
    const nodes = parseInline('``a ` b``')
    const code = nodes[0]!
    if (code.kind !== 'code') throw new Error('unreachable')
    expect(code.value).toBe('a ` b')
  })

  it('strips one padding space each side', () => {
    const nodes = parseInline('`` ` ``')
    const code = nodes[0]!
    if (code.kind !== 'code') throw new Error('unreachable')
    expect(code.value).toBe('`')
  })

  it('keeps an unterminated backtick literal', () => {
    expect(textOf(parseInline('`open'))).toBe('`open')
  })

  it('does not let a code span supply a closer for emphasis', () => {
    // `**a `b* c`` must not become emphasis using the `*` inside the code span.
    const nodes = parseInline('*a `b* c`')
    expect(kinds(nodes)).not.toContain('em')
  })
})

describe('parseInline · links', () => {
  it('parses a safe link', () => {
    const nodes = parseInline('see [docs](https://example.com/x)')
    const link = nodes[1]!
    expect(link.kind).toBe('link')
    if (link.kind !== 'link') throw new Error('unreachable')
    expect(link.href).toBe('https://example.com/x')
    expect(textOf(link.children)).toBe('docs')
  })

  it('degrades an unsafe link to its label text, keeping the words', () => {
    const nodes = parseInline('[click me](javascript:alert(1))')
    expect(kinds(nodes)).not.toContain('link')
    // Dropping the text would hide model output; only the target is refused.
    expect(textOf(nodes)).toBe('click me')
  })

  it('parses emphasis inside a link label', () => {
    const nodes = parseInline('[**bold** link](https://example.com)')
    const link = nodes[0]!
    if (link.kind !== 'link') throw new Error('unreachable')
    expect(kinds(link.children)).toContain('strong')
  })

  it('drops a title suffix from the target', () => {
    const nodes = parseInline('[x](https://example.com "Title")')
    const link = nodes[0]!
    if (link.kind !== 'link') throw new Error('unreachable')
    expect(link.href).toBe('https://example.com')
  })

  it('handles parentheses inside the target', () => {
    const nodes = parseInline('[wiki](https://en.wikipedia.org/wiki/X_(y))')
    const link = nodes[0]!
    if (link.kind !== 'link') throw new Error('unreachable')
    expect(link.href).toBe('https://en.wikipedia.org/wiki/X_(y)')
  })

  it('leaves a bare bracket literal', () => {
    expect(textOf(parseInline('an [unclosed thing'))).toBe('an [unclosed thing')
    expect(textOf(parseInline('[label] no target'))).toBe('[label] no target')
  })

  it('treats raw HTML as literal text, never markup', () => {
    // There is no HTML passthrough at all, so an injection attempt renders as
    // the characters the model actually emitted.
    const nodes = parseInline('<img src=x onerror=alert(1)>')
    expect(kinds(nodes)).toEqual(['text'])
    expect(textOf(nodes)).toBe('<img src=x onerror=alert(1)>')
  })
})

describe('parseMarkdown · blocks', () => {
  it('parses ATX headings and strips trailing hashes', () => {
    const blocks = parseMarkdown('# One\n\n### Three ###')
    expect(blocks).toHaveLength(2)
    const first = blocks[0]!
    const second = blocks[1]!
    if (first.kind !== 'heading' || second.kind !== 'heading') throw new Error('unreachable')
    expect(first.level).toBe(1)
    expect(textOf(first.children)).toBe('One')
    expect(second.level).toBe(3)
    expect(textOf(second.children)).toBe('Three')
  })

  it('requires a space after the hashes, so #hashtag is a paragraph', () => {
    expect(parseMarkdown('#hashtag')[0]!.kind).toBe('paragraph')
  })

  it('treats a single newline as a line break inside a paragraph', () => {
    // Strict Markdown folds these into spaces, but an assistant writing into a
    // chat panel means one newline as one break.
    const block = parseMarkdown('line one\nline two')[0]!
    if (block.kind !== 'paragraph') throw new Error('unreachable')
    expect(kinds(block.children)).toContain('break')
  })

  it('drops trailing newlines so streamed replies do not end on an extra block', () => {
    // Providers commonly finish a streamed turn with a trailing "\n"; rendering
    // it as a <br> pushes the last characters onto a dangling line/block.
    const block = parseMarkdown('All done.\n')[0]!
    if (block.kind !== 'paragraph') throw new Error('unreachable')
    expect(kinds(block.children)).not.toContain('break')
    expect(kinds(block.children).filter((k) => k === 'text')).toHaveLength(1)
  })

  it('splits paragraphs on a blank line', () => {
    const blocks = parseMarkdown('one\n\ntwo')
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'paragraph'])
  })

  it('parses a fenced code block with a language', () => {
    const block = parseMarkdown('```ts\nconst a = 1\n```')[0]!
    if (block.kind !== 'code') throw new Error('unreachable')
    expect(block.lang).toBe('ts')
    expect(block.value).toBe('const a = 1')
    expect(block.closed).toBe(true)
  })

  it('reports an unclosed fence so the UI can show it as still arriving', () => {
    const block = parseMarkdown('```js\nlet x')[0]!
    if (block.kind !== 'code') throw new Error('unreachable')
    expect(block.closed).toBe(false)
    expect(block.value).toBe('let x')
  })

  it('keeps markup inside a fence literal', () => {
    const block = parseMarkdown('```\n# not a heading\n**not bold**\n```')[0]!
    if (block.kind !== 'code') throw new Error('unreachable')
    expect(block.value).toBe('# not a heading\n**not bold**')
  })

  it('supports tilde fences, so a block can contain backticks', () => {
    const block = parseMarkdown('~~~\n```\n~~~')[0]!
    if (block.kind !== 'code') throw new Error('unreachable')
    expect(block.value).toBe('```')
  })

  it('parses bullet lists with any marker', () => {
    for (const marker of ['-', '*', '+']) {
      const block = parseMarkdown(`${marker} a\n${marker} b`)[0]!
      if (block.kind !== 'list') throw new Error('unreachable')
      expect(block.ordered).toBe(false)
      expect(block.items).toHaveLength(2)
    }
  })

  it('parses ordered lists and preserves the starting number', () => {
    const block = parseMarkdown('3. three\n4. four')[0]!
    if (block.kind !== 'list') throw new Error('unreachable')
    expect(block.ordered).toBe(true)
    expect(block.start).toBe(3)
    expect(block.items).toHaveLength(2)
  })

  it('nests a deeper list inside its parent item', () => {
    const block = parseMarkdown('- outer\n  - inner\n- second')[0]!
    if (block.kind !== 'list') throw new Error('unreachable')
    expect(block.items).toHaveLength(2)
    const nested = block.items[0]!.blocks.find((child) => child.kind === 'list')
    expect(nested).toBeDefined()
  })

  it('parses inline markup inside list items', () => {
    const block = parseMarkdown('- **bold** item')[0]!
    if (block.kind !== 'list') throw new Error('unreachable')
    const paragraph = block.items[0]!.blocks[0]!
    if (paragraph.kind !== 'paragraph') throw new Error('unreachable')
    expect(kinds(paragraph.children)).toContain('strong')
  })

  it('parses a blockquote', () => {
    const block = parseMarkdown('> quoted\n> more')[0]!
    if (block.kind !== 'quote') throw new Error('unreachable')
    expect(block.blocks[0]!.kind).toBe('paragraph')
  })

  it('parses a thematic break, and prefers it over a list marker', () => {
    expect(parseMarkdown('---')[0]!.kind).toBe('hr')
    expect(parseMarkdown('***')[0]!.kind).toBe('hr')
    expect(parseMarkdown('- - -')[0]!.kind).toBe('hr')
  })

  it('parses a table with alignment', () => {
    const block = parseMarkdown('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |')[0]!
    if (block.kind !== 'table') throw new Error('unreachable')
    expect(block.head.map((cell) => textOf(cell))).toEqual(['a', 'b', 'c'])
    expect(block.align).toEqual(['left', 'center', 'right'])
    expect(block.rows).toHaveLength(1)
    expect(block.rows[0]!.map((cell) => textOf(cell))).toEqual(['1', '2', '3'])
  })

  it('needs a delimiter row, so a bare pipe stays a paragraph', () => {
    expect(parseMarkdown('a | b')[0]!.kind).toBe('paragraph')
  })

  it('respects escaped pipes in a cell', () => {
    const block = parseMarkdown('| a | b |\n|---|---|\n| x \\| y | z |')[0]!
    if (block.kind !== 'table') throw new Error('unreachable')
    expect(block.rows[0]!.map((cell) => textOf(cell))).toEqual(['x | y', 'z'])
  })

  it('lets a heading, fence, or list interrupt a paragraph', () => {
    // Models routinely omit the blank line before a new construct.
    expect(parseMarkdown('text\n# Heading').map((b: Block) => b.kind)).toEqual([
      'paragraph',
      'heading',
    ])
    expect(parseMarkdown('text\n- item').map((b: Block) => b.kind)).toEqual([
      'paragraph',
      'list',
    ])
    expect(parseMarkdown('text\n```\ncode\n```').map((b: Block) => b.kind)).toEqual([
      'paragraph',
      'code',
    ])
  })

  it('normalizes CRLF, since pasted content often carries it', () => {
    const blocks = parseMarkdown('# One\r\n\r\ntext\r\n')
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph'])
    const heading = blocks[0]!
    if (heading.kind !== 'heading') throw new Error('unreachable')
    expect(textOf(heading.children)).toBe('One')
  })

  it('returns nothing for empty or whitespace-only input', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('\n\n  \n')).toEqual([])
  })

  /**
   * The renderer is called on every partial prefix of a streaming reply, so any
   * prefix that throws would blank the panel mid-answer.
   */
  it('never throws on any prefix of a rich document', () => {
    const document = [
      '# Title',
      '',
      'Some **bold** and `code` and [a link](https://example.com).',
      '',
      '- item one',
      '  - nested',
      '- item two',
      '',
      '> quoted text',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '```ts',
      'const x: number = 1',
      '```',
      '',
      '---',
    ].join('\n')

    for (let i = 0; i <= document.length; i += 1) {
      expect(() => parseMarkdown(document.slice(0, i))).not.toThrow()
    }
  })

  it('never throws on pathological delimiter soup', () => {
    for (const input of [
      '*'.repeat(200),
      '`'.repeat(200),
      '['.repeat(200),
      '~~~~~~~~~~',
      '#'.repeat(50),
      '- '.repeat(100),
      '|'.repeat(100),
      '\\'.repeat(100),
      '**[`*_~',
    ]) {
      expect(() => parseMarkdown(input)).not.toThrow()
    }
  })
})
