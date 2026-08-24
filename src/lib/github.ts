/**
 * Fetches "PRs waiting for my review" using the browser's logged-in GitHub
 * session — no personal access token is stored.
 *
 * ## Why an Atom feed, not the API or page scraping
 *
 * - The REST/GraphQL API needs a token. The user explicitly wants to rely on the
 *   existing browser login and run with no stored credential, so that path is out.
 * - Scraping `github.com/pulls/review-requested` HTML is brittle: GitHub ships
 *   progressively-rendered markup and class names that change without notice.
 * - The authenticated Atom feed at `/pulls/review-requested.atom` returns the
 *   same data, for the logged-in user, as stable XML. It is the one structured,
 *   cookie-authenticated surface GitHub publishes without a token.
 *
 * ## Why a background tab, not `fetch()`
 *
 * A `fetch('https://github.com/pulls/review-requested.atom', {credentials:
 * 'include'})` from the extension origin *does* send cookies, but GitHub returns
 * a 404 to cross-origin/extension requests even when the cookies are valid
 * (the endpoint is shaped for top-level navigation/feeds, not CORS). Opening it
 * in a tab gets the real response the same way clicking the link does. The tab
 * is created inactive and closed as soon as the text is read, so it does not
 * steal focus.
 *
 * ## Login failure
 *
 * If not logged in, GitHub redirects the feed to the login page. We detect that
 * instead of trying to parse HTML as Atom and surface it as {@link NotLoggedIn}
 * so the runner can skip the task (and notify once) rather than reporting a
 * misleading "0 PRs".
 *
 * @module lib/github
 */

/** Thrown when the GitHub session is not authenticated. */
export class NotLoggedIn extends Error {
  constructor() {
    super('Not logged in to GitHub. Open github.com and sign in, then run the task again.')
    this.name = 'NotLoggedIn'
  }
}

/** One PR awaiting review. */
export interface ReviewItem {
  title: string
  url: string
  repo: string
  author: string
  updatedAt: string
}

/** Result of a review-requests fetch. */
export interface ReviewRequests {
  totalCount: number
  items: ReviewItem[]
  /**
   * The feed is capped by GitHub; `incomplete` means there are more than
   * `items.length` entries on the server.
   */
  incomplete: boolean
}

const FEED_URL = 'https://github.com/pulls/review-requested.atom'
const LOGIN_MARKER = 'Sign in to GitHub'
const GITHUB_HOST = 'github.com'

/**
 * Parses the Atom feed XML.
 *
 * Exported as a pure function because the DOM/DOMParser path is trivially
 * unit-testable with a string (the DOMParser is injected so tests can run in
 * Node without a browser), while the tab-fetching wrapper is not. Returns null
 * when the document is not an Atom feed (e.g. the login page).
 */
export function parseReviewFeed(
  xml: string,
  parse: (source: string) => Document = (source) => new DOMParser().parseFromString(source, 'application/xml'),
): ReviewRequests | null {
  if (!xml || xml.length === 0) return null
  // A login redirect never contains an Atom <feed> root; be explicit so the
  // caller gets NotLoggedIn rather than an empty result.
  if (xml.includes('<html') || xml.includes(LOGIN_MARKER)) return null

  const doc = parse(xml)
  // A parse error produces a <parsererror>; treat it like "not a feed".
  if (doc.getElementsByTagName('parsererror').length > 0) return null
  const root = doc.documentElement
  if (!root || root.nodeName !== 'feed') return null

  const entries = Array.from(doc.getElementsByTagName('entry'))
  const items: ReviewItem[] = []
  for (const entry of entries) {
    const get = (tag: string): string =>
      entry.getElementsByTagName(tag)[0]?.textContent?.trim() ?? ''
    const linkEl = entry.getElementsByTagName('link')[0]
    const href = linkEl?.getAttribute('href') ?? ''
    // Repo is the first path segment pair in the PR URL: /owner/repo/pulls/123.
    const repo = extractRepo(href)
    items.push({
      title: get('title'),
      url: href,
      repo,
      author: entry.getElementsByTagName('author')[0]?.getElementsByTagName('name')[0]
        ?.textContent ?? '',
      updatedAt: get('updated'),
    })
  }

  return {
    totalCount: items.length,
    items,
    // GitHub's review-requested feed returns a capped window; we can't know the
    // exact server total without the API, but the presence of the feed's own link
    // rel="next" would indicate more. Conservatively flag incompleteness when we
    // hit a reasonable cap of entries.
    incomplete: items.length >= 30,
  }
}

function extractRepo(url: string): string {
  try {
    const path = new URL(url).pathname.split('/').filter(Boolean)
    if (path.length >= 2) return `${path[0]}/${path[1]}`
  } catch {
    // fall through
  }
  return ''
}

/**
 * Fetches the review-requested feed in an inactive background tab.
 *
 * The tab is always closed before this returns (success or failure).
 *
 * @throws {NotLoggedIn} when GitHub served the login page.
 * @throws {Error} on any failure to load or read the tab.
 */
export async function fetchReviewRequests(): Promise<ReviewRequests> {
  const created = await chrome.tabs.create({ url: FEED_URL, active: false })
  const tabId = created.id
  if (typeof tabId !== 'number') {
    throw new Error('Could not open a background tab to read GitHub.')
  }

  try {
    // Wait for the page to settle. Listening for status==='complete' would be
    // ideal, but the feed is tiny; a bounded wait is simpler and robust to the
    // service worker being evicted between events.
    await waitForTabReady(tabId)

    const injections = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => {
        // document.documentElement.outerHTML for the XML feed gives the serialized
        // feed; for the login page it gives HTML, which parseReviewFeed rejects.
        return {
          url: location.href,
          text: document.documentElement?.outerText ?? '',
          html: document.documentElement?.outerHTML ?? '',
        }
      },
    })

    const value = injections[0]?.result as
      | { url: string; text: string; html: string }
      | undefined
    if (!value) throw new Error('Could not read the GitHub tab.')

    // If we landed anywhere other than the feed (a redirect to login, an SSO
    // interstitial, an enterprise redirect) treat it as not authenticated for
    // this purpose.
    const onFeed = new URL(value.url).host === GITHUB_HOST && value.url.includes('review-requested')
    const parsed = parseReviewFeed(value.html)
    if (!parsed) {
      // Distinguish "not logged in" from "weird response": the text mentioning
      // the sign-in marker is the reliable signal.
      if (value.text.includes(LOGIN_MARKER) || !onFeed) {
        throw new NotLoggedIn()
      }
      throw new Error('GitHub returned an unrecognised response for the review feed.')
    }
    return parsed
  } finally {
    // Best-effort close; never let a failure leak a tab.
    try {
      await chrome.tabs.remove(tabId)
    } catch {
      // The tab may have already navigated/closed; that is fine.
    }
  }
}

/**
 * Resolves once the tab finishes loading or a short timeout elapses.
 *
 * The timeout is intentional: a slow or hung GitHub load must not leave the
 * task (and the service worker) waiting forever. After the timeout we attempt
 * the read anyway; the feed is small enough to usually be present.
 */
function waitForTabReady(tabId: number, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    const listener = (
      updatedId: number,
      info: chrome.tabs.TabChangeInfo,
    ): void => {
      if (updatedId === tabId && info.status === 'complete') finish()
    }
    chrome.tabs.onUpdated.addListener(listener)
    setTimeout(finish, timeoutMs)
  })
}

/**
 * Builds a concise summary line and an optional detail block for Feishu.
 *
 * Pure so it can be tested without Chrome.
 */
export function formatReviewSummary(result: ReviewRequests, locale: string = 'en'): {
  headline: string
  body: string
} {
  const zh = locale.toLowerCase().startsWith('zh')
  if (result.totalCount === 0) {
    return {
      headline: zh ? '✅ 没有待你 review 的 PR' : '✅ No PRs waiting for your review',
      body: '',
    }
  }
  const headline = zh
    ? `🔔 有 ${result.totalCount} 个 PR 待你 review${result.incomplete ? '（可能更多）' : ''}`
    : `🔔 ${result.totalCount} PR${result.totalCount === 1 ? '' : 's'} waiting for your review${
        result.incomplete ? ' (possibly more)' : ''
      }`

  const lines = result.items.slice(0, 15).map((item) => {
    const repo = item.repo ? `${item.repo} · ` : ''
    return `• [${repo}${item.title}](${item.url})`
  })
  if (result.items.length > 15) {
    lines.push(
      zh
        ? `…以及另外 ${result.items.length - 15} 个`
        : `…and ${result.items.length - 15} more`,
    )
  }
  lines.push(FEED_URL)
  return { headline, body: lines.join('\n') }
}
