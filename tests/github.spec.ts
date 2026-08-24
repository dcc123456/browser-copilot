import { describe, expect, it } from 'vitest'
import {
  NotLoggedIn,
  formatReviewSummary,
  parseReviewFeed,
} from '../src/lib/github'

/**
 * Minimal DOMParser stand-in for Node.
 *
 * The real code runs against the browser's DOMParser; tests only need to confirm
 * the extraction logic, so a tiny tag-walking parser suffices and avoids a jsdom
 * dependency. It handles exactly the Atom elements the code looks at.
 */
class FakeElement {
  children: FakeElement[] = []
  textContent = ''
  attributes: Record<string, string> = {}
  constructor(public nodeName: string) {}
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }
  getElementsByTagName(name: string): FakeElement[] {
    const out: FakeElement[] = []
    const walk = (el: FakeElement): void => {
      for (const child of el.children) {
        if (child.nodeName === name) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
}

class FakeDocument {
  documentElement: FakeElement | null = null
  getElementsByTagName(name: string): FakeElement[] {
    if (!this.documentElement) return []
    if (this.documentElement.nodeName === name) return [this.documentElement]
    return this.documentElement.getElementsByTagName(name)
  }
}

function parseXml(xml: string): Document {
  // Regex-based: strips the declaration, splits tags naively, but enough for the
  // controlled feed strings in these tests.
  const doc = new FakeDocument()
  const stack: FakeElement[] = []
  const re = /<(\/?)([a-zA-Z:]+)([^>]*)?(\/?)>|([^<]+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) {
    const [full, closing, tag, attrs, selfClosing, text] = match
    if (text) {
      const top = stack[stack.length - 1]
      if (top) top.textContent += text.trim()
      continue
    }
    if (closing) {
      stack.pop()
      continue
    }
    const el = new FakeElement(tag)
    if (attrs) {
      const attrRe = /(\w+)="([^"]*)"/g
      let am: RegExpExecArray | null
      while ((am = attrRe.exec(attrs))) el.attributes[am[1]!] = am[2]!
    }
    if (stack.length === 0) doc.documentElement = el
    else stack[stack.length - 1]!.children.push(el)
    if (!selfClosing && !full.endsWith('/>')) stack.push(el)
  }
  return doc as unknown as Document
}

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Pull Requests</title>
  <entry>
    <title>feat: add dark mode</title>
    <link href="https://github.com/acme/web/pull/42"/>
    <updated>2024-05-01T10:00:00Z</updated>
    <author><name>octocat</name></author>
  </entry>
  <entry>
    <title>fix: race condition</title>
    <link href="https://github.com/acme/api/pull/7"/>
    <updated>2024-05-02T11:00:00Z</updated>
    <author><name>hubot</name></author>
  </entry>
</feed>`

describe('parseReviewFeed', () => {
  it('extracts entries, repo, title, and author', () => {
    const result = parseReviewFeed(SAMPLE_FEED, parseXml)
    expect(result).not.toBeNull()
    expect(result!.totalCount).toBe(2)
    expect(result!.items[0]).toMatchObject({
      title: 'feat: add dark mode',
      url: 'https://github.com/acme/web/pull/42',
      repo: 'acme/web',
      author: 'octocat',
    })
    expect(result!.items[1]!.repo).toBe('acme/api')
  })

  it('returns null for empty input', () => {
    expect(parseReviewFeed('', parseXml)).toBeNull()
    expect(parseReviewFeed('   ', parseXml)).toBeNull()
  })

  it('returns null for the login page HTML', () => {
    const html =
      '<html><body><title>Sign in to GitHub</title>Sign in to GitHub · GitHub</body></html>'
    expect(parseReviewFeed(html, parseXml)).toBeNull()
  })

  it('returns null when a parsererror is present', () => {
    const broken = `<?xml version="1.0"?><parsererror>boom</parsererror>`
    expect(parseReviewFeed(broken, parseXml)).toBeNull()
  })

  it('returns null when the root is not a feed', () => {
    expect(parseReviewFeed('<html></html>', parseXml)).toBeNull()
  })

  it('flags incompleteness at the 30-entry cap', () => {
    const entries = Array.from({ length: 31 }, (_, i) =>
      `<entry><title>PR ${i}</title><link href="https://github.com/o/r/pull/${i}"/></entry>`,
    ).join('')
    const feed = `<feed>${entries}</feed>`
    const result = parseReviewFeed(feed, parseXml)
    expect(result!.incomplete).toBe(true)
  })
})

describe('formatReviewSummary', () => {
  it('reports zero PRs without a list', () => {
    const s = formatReviewSummary({ totalCount: 0, items: [], incomplete: false }, 'en')
    expect(s.headline).toContain('No PRs')
    expect(s.body).toBe('')
  })

  it('formats a list with links and a count in Chinese', () => {
    const s = formatReviewSummary(
      {
        totalCount: 1,
        items: [
          {
            title: 'x',
            url: 'https://github.com/o/r/pull/1',
            repo: 'o/r',
            author: '',
            updatedAt: '',
          },
        ],
        incomplete: false,
      },
      'zh-CN',
    )
    expect(s.headline).toContain('1')
    expect(s.body).toContain('o/r')
    expect(s.body).toContain('https://github.com/o/r/pull/1')
  })
})

describe('NotLoggedIn', () => {
  it('has a stable name so the runner can branch on it', () => {
    const err = new NotLoggedIn()
    expect(err.name).toBe('NotLoggedIn')
    expect(err.message).toMatch(/sign in/i)
  })
})
