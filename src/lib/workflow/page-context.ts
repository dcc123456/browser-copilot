/**
 * Page context — "am I on the page this workflow was made for?" (spec §11).
 *
 * A generated workflow is grounded in the page it was generated ON. Before a
 * strict run's actions fire, the runtime compares the CURRENT page against
 * the expected context; a mismatch is a structured WRONG_ORIGIN / WRONG_PAGE
 * failure, never a best-effort attempt on the wrong site (clicking a login
 * button on the wrong origin is exactly the bug class this guard exists to
 * prevent).
 *
 * The expected context is derived from what generation actually knew:
 * `settings.generationOriginUrl` (the origin the graph was generated on), or
 * an explicit `settings.pageContext` fingerprint for callers that can state
 * more (pathname pattern / title hint). Nothing is invented: no recorded
 * origin → no guard.
 *
 * @module lib/workflow/page-context
 */

import { hasReference } from './dynamic-data'

/** The declared page context a workflow expects at run time. */
export interface PageContextFingerprint {
  /** Origin the workflow was generated for (scheme + host + port). */
  origin: string
  /** Optional pathname prefix or glob-ish pattern the page should match. */
  pathnamePattern?: string
  /** Optional case-insensitive substring expected in the document title. */
  titleHint?: string
}

/**
 * The current page's observable identity, as the runtime can cheaply provide.
 */
export interface CurrentPageContext {
  url?: string
  title?: string
}

export type PageContextVerdict =
  | { ok: true }
  | { ok: false; code: 'WRONG_ORIGIN' | 'WRONG_PAGE'; message: string }

/** Origin of a URL string, '' when unparseable. */
export function originOfUrl(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * Blocks that navigate somewhere of their own accord before any page is
 * acted on. For these the page UNDER ACT IS THE DESTINATION — gating them on
 * the stale current tab rejects a workflow whose very first step walks onto
 * the grounded site (the false WRONG_ORIGIN class).
 */
const NAVIGATION_BLOCKS: ReadonlySet<string> = new Set(['new-tab', 'open-url'])

/**
 * The destination URL a navigation block is about to open, when the block is
 * one and the (already interpolated) params carry a resolvable http(s) url.
 * Undefined ⇒ the guard must fall back to the current page.
 */
export function navigationDestinationOf(
  blockId: string,
  params: Record<string, unknown>,
): string | undefined {
  if (!NAVIGATION_BLOCKS.has(blockId)) return undefined
  const raw = params['url']
  if (typeof raw !== 'string') return undefined
  const url = raw.trim()
  if (!/^https?:\/\//i.test(url) || hasReference(url)) return undefined
  return originOfUrl(url) ? url : undefined
}

/**
 * Derive the expected page context from workflow settings. Returns undefined
 * when the workflow carries no grounding (never gate on invented facts).
 */
export function pageContextOf(workflow: {
  settings?: unknown
}): PageContextFingerprint | undefined {
  const settings = (workflow.settings ?? {}) as Record<string, unknown>
  const explicit = settings['pageContext'] as PageContextFingerprint | undefined
  if (
    explicit &&
    typeof explicit === 'object' &&
    typeof explicit.origin === 'string' &&
    explicit.origin.trim()
  ) {
    return {
      origin: explicit.origin.trim(),
      ...(typeof explicit.pathnamePattern === 'string' && explicit.pathnamePattern.trim()
        ? { pathnamePattern: explicit.pathnamePattern.trim() }
        : {}),
      ...(typeof explicit.titleHint === 'string' && explicit.titleHint.trim()
        ? { titleHint: explicit.titleHint.trim() }
        : {}),
    }
  }
  const generated = settings['generationOriginUrl']
  if (typeof generated === 'string' && generated.trim()) {
    const origin = originOfUrl(generated.trim())
    if (origin && origin !== 'null') return { origin }
  }
  return undefined
}

/** Pattern match with a leading/trailing-glob shortcut (`/docs/*`). */
function pathnameMatches(pathname: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return pathname.startsWith(pattern.slice(0, -1))
  }
  return pathname.startsWith(pattern)
}

/**
 * Compare the current page against the expected fingerprint. Origin first —
 * a different origin makes every locator answer meaningless.
 *
 * `subject.label` names what is being compared (当前页面 vs 导航目标) so a
 * destination check never reports the destination as if it were the page the
 * user is standing on.
 */
export function checkPageContext(
  expected: PageContextFingerprint,
  current: CurrentPageContext,
  subject: { label?: string } = {},
): PageContextVerdict {
  const who = subject.label ?? '当前页面'
  const url = current.url ?? ''
  if (!url) return { ok: true } // nothing observed yet — do not invent a failure
  const actualOrigin = originOfUrl(url)
  if (actualOrigin && actualOrigin !== expected.origin) {
    return {
      ok: false,
      code: 'WRONG_ORIGIN',
      message: `${who}（${actualOrigin}）不是该工作流的目标站点（${expected.origin}）`,
    }
  }
  if (expected.pathnamePattern) {
    let pathname = ''
    try {
      pathname = new URL(url).pathname
    } catch {
      pathname = ''
    }
    if (pathname && !pathnameMatches(pathname, expected.pathnamePattern)) {
      return {
        ok: false,
        code: 'WRONG_PAGE',
        message: `${who}路径（${pathname}）不符合预期（${expected.pathnamePattern}）`,
      }
    }
  }
  if (expected.titleHint && current.title && !current.title.toLowerCase().includes(expected.titleHint.toLowerCase())) {
    return {
      ok: false,
      code: 'WRONG_PAGE',
      message: `页面标题（${current.title.slice(0, 60)}）不含预期关键词（${expected.titleHint}）`,
    }
  }
  return { ok: true }
}
