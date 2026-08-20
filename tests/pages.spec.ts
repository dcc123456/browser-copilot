import { describe, expect, it } from 'vitest'
import { isInjectablePage, isSamePage } from '../src/lib/pages'

/**
 * This predicate decides whether the assistant may read a tab at all, so a
 * false positive turns into an opaque injection failure mid-conversation and a
 * false negative silently refuses a page the user can plainly see.
 */
describe('isInjectablePage', () => {
  it('accepts ordinary http and https pages', () => {
    for (const url of [
      'https://example.com',
      'http://example.com/path?query=1#hash',
      'https://sub.domain.example.co.uk/a/b',
      // Localhost is an ordinary page as far as injection is concerned.
      'http://localhost:3000/app',
    ]) {
      expect(isInjectablePage(url), url).toBe(true)
    }
  })

  // Chrome blocks these regardless of granted permissions, so detecting them
  // early is the only way to explain the refusal instead of reporting a crash.
  it('rejects browser-internal schemes', () => {
    for (const url of [
      'chrome://settings',
      'chrome-extension://abcdef/page.html',
      'edge://flags',
      'about:blank',
      'devtools://devtools/bundled/inspector.html',
      'view-source:https://example.com',
      'file:///C:/Users/me/notes.txt',
    ]) {
      expect(isInjectablePage(url), url).toBe(false)
    }
  })

  it('rejects extension gallery pages', () => {
    for (const url of [
      'https://chrome.google.com/webstore/category/extensions',
      'https://chromewebstore.google.com/detail/abc',
      'https://microsoftedge.microsoft.com/addons/detail/abc',
    ]) {
      expect(isInjectablePage(url), url).toBe(false)
    }
  })

  it('rejects non-http schemes outright', () => {
    for (const url of ['ftp://example.com', 'data:text/html,hi', 'javascript:void(0)', 'mailto:a@b.c']) {
      expect(isInjectablePage(url), url).toBe(false)
    }
  })

  // A tab with no URL is normal while it is still loading, and must not be
  // treated as readable.
  it('rejects a missing or empty URL', () => {
    expect(isInjectablePage(undefined)).toBe(false)
    expect(isInjectablePage('')).toBe(false)
  })

  it('matches schemes case-insensitively', () => {
    expect(isInjectablePage('HTTPS://example.com')).toBe(true)
    expect(isInjectablePage('CHROME://settings')).toBe(false)
    expect(isInjectablePage('https://CHROMEWEBSTORE.google.com/detail/x')).toBe(false)
  })

  // A blocked host must not be evadable by a URL that merely mentions it.
  it('only blocks the gallery as a prefix, not anywhere in the URL', () => {
    expect(isInjectablePage('https://example.com/?ref=https://chromewebstore.google.com')).toBe(
      true,
    )
  })
})

/**
 * This decides whether a page the user attached still counts as "the same page"
 * when the model later asks to read it, i.e. whether the confirmation prompt is
 * waived. Over-matching would silently read a page the user never consented to,
 * so the negative cases matter more than the positive ones.
 */
describe('isSamePage', () => {
  it('matches a URL to itself', () => {
    expect(isSamePage('https://example.com/a', 'https://example.com/a')).toBe(true)
  })

  it('ignores the fragment, which never changes the document', () => {
    expect(isSamePage('https://example.com/a#top', 'https://example.com/a')).toBe(true)
    expect(isSamePage('https://example.com/a', 'https://example.com/a#section-2')).toBe(true)
  })

  it('ignores a trailing slash', () => {
    // Chrome's reported tab URL and the page's own location.href routinely
    // differ here, and re-prompting for that would be pure noise.
    expect(isSamePage('https://example.com/', 'https://example.com')).toBe(true)
    expect(isSamePage('https://example.com/a/', 'https://example.com/a')).toBe(true)
  })

  it('ignores the query string, so an SPA rewriting it does not re-prompt', () => {
    expect(isSamePage('https://example.com/app?tab=1', 'https://example.com/app?tab=2')).toBe(true)
  })

  it('treats a different path as a different page', () => {
    expect(isSamePage('https://example.com/a', 'https://example.com/b')).toBe(false)
    expect(isSamePage('https://example.com/', 'https://example.com/admin')).toBe(false)
  })

  it('treats a different host as a different page', () => {
    // The security case: consent for one site must never cover another.
    expect(isSamePage('https://example.com/a', 'https://evil.com/a')).toBe(false)
    expect(isSamePage('https://example.com/a', 'https://sub.example.com/a')).toBe(false)
  })

  it('treats a different scheme or port as a different origin', () => {
    expect(isSamePage('https://example.com/a', 'http://example.com/a')).toBe(false)
    expect(isSamePage('http://localhost:3000/a', 'http://localhost:4000/a')).toBe(false)
  })

  it('keeps the path case-sensitive, since paths are', () => {
    expect(isSamePage('https://example.com/Admin', 'https://example.com/admin')).toBe(false)
  })

  it('matches the host case-insensitively, since hosts are not case-sensitive', () => {
    expect(isSamePage('https://EXAMPLE.com/a', 'https://example.com/a')).toBe(true)
  })

  it('fails closed on missing or unparseable input', () => {
    // Anything it cannot prove identical must re-prompt rather than assume.
    expect(isSamePage(undefined, 'https://example.com')).toBe(false)
    expect(isSamePage('https://example.com', undefined)).toBe(false)
    expect(isSamePage('', '')).toBe(false)
    expect(isSamePage('not a url', 'not a url')).toBe(false)
    expect(isSamePage('https://example.com', 'not a url')).toBe(false)
  })
})
