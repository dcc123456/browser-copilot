/**
 * Which pages an extension may touch.
 *
 * Kept free of `chrome` APIs so the rule is unit-testable: every reader in this
 * project (page scraping today, anything added later) must agree on it, and
 * getting it wrong produces an opaque injection failure at runtime rather than a
 * clear refusal.
 *
 * @module lib/pages
 */

/**
 * URL schemes and hosts where no extension content script may run.
 *
 * These are enforced by Chrome, not by policy here: injecting into them fails
 * regardless of the permissions granted, so the only useful thing this project
 * can do is detect them early and say so.
 */
const BLOCKED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'extension://',
  'about:',
  'devtools://',
  'view-source:',
  'file://',
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com',
  'https://microsoftedge.microsoft.com/addons',
]

/**
 * True when two URLs identify the same page for consent purposes.
 *
 * Compared by origin plus path, ignoring the query string and fragment. A
 * fragment never changes the document, and Chrome routinely reports a URL that
 * differs from the page's own `location.href` in trailing-slash or fragment
 * detail — so exact string equality would spuriously re-prompt for the very page
 * the user just attached.
 *
 * The query string is excluded for the same reason on single-page apps, which
 * rewrite it as the user interacts. That is a deliberate widening of the grant:
 * it covers a different view of the same document, not a different site. Origin
 * and path must still match exactly, so a navigation to another page — or
 * another site — re-gates the read.
 */
export function isSamePage(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  try {
    const left = new URL(a)
    const right = new URL(b)
    // Compare origins case-insensitively (the URL parser already lowercases
    // host and scheme) but keep the path case-sensitive, since paths are.
    if (left.origin !== right.origin) return false
    const normalize = (path: string): string =>
      path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
    return normalize(left.pathname) === normalize(right.pathname)
  } catch {
    // An unparseable URL cannot be shown to be the same page, so it is not.
    return false
  }
}

/** True when this URL is an ordinary http(s) page the assistant can read. */
export function isInjectablePage(url: string | undefined): boolean {
  if (!url) return false
  if (!/^https?:\/\//i.test(url)) return false
  const lower = url.toLowerCase()
  return !BLOCKED_PREFIXES.some((prefix) => lower.startsWith(prefix))
}
