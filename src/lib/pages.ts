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

/** True when this URL is an ordinary http(s) page the assistant can read. */
export function isInjectablePage(url: string | undefined): boolean {
  if (!url) return false
  if (!/^https?:\/\//i.test(url)) return false
  const lower = url.toLowerCase()
  return !BLOCKED_PREFIXES.some((prefix) => lower.startsWith(prefix))
}
