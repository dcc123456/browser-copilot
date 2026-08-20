import { describe, expect, it } from 'vitest'
import { isInjectablePage } from '../src/lib/pages'

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
