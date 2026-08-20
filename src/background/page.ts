/**
 * Reading the current page as agent context.
 *
 * Injection runs in the default ISOLATED world: this only reads the DOM, so
 * there is no reason to share scope with page scripts, and an isolated world
 * cannot be observed or tampered with by them.
 *
 * @module background/page
 */

import { DEFAULT_MAX_CHARS, collapseWhitespace, truncate } from '../lib/extract'
import { isInjectablePage } from '../lib/pages'
import type { PageContext } from '../lib/types'

/** Elements whose text is never useful as reading context. */
const STRIP_SELECTOR = 'script, style, noscript, template, svg, canvas, iframe, object, embed'

/**
 * Serialized into the page. Returns raw text; whitespace normalization and
 * truncation happen in the worker so they stay testable.
 */
function scrapeInPage(stripSelector: string): {
  url: string
  title: string
  selection: string
  raw: string
} {
  const selection = window.getSelection()?.toString() ?? ''
  const source = document.body ?? document.documentElement
  let raw = ''
  if (source) {
    // Clone so removing noise never mutates the live page.
    const clone = source.cloneNode(true) as HTMLElement
    clone.querySelectorAll(stripSelector).forEach((node) => {
      node.remove()
    })
    raw = clone.innerText || clone.textContent || ''
  }
  return { url: location.href, title: document.title, selection, raw }
}

/** Resolves the tab to read: the active tab of the focused window. */
export async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (focused) return focused
  const [anyActive] = await chrome.tabs.query({ active: true })
  return anyActive
}

/**
 * Reads the active tab's text.
 *
 * @throws {Error} when no tab is available or the page forbids injection —
 *   surfaced to the model so it can tell the user instead of inventing content.
 */
export async function readActivePage(maxChars = DEFAULT_MAX_CHARS): Promise<PageContext> {
  const tab = await activeTab()
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('No active tab to read.')
  }
  if (!isInjectablePage(tab.url)) {
    throw new Error(
      `Cannot read ${tab.url ?? 'this page'}: browser-internal, local-file, and Web Store pages are off limits to extensions.`,
    )
  }

  const [injection] = await chrome.scripting.executeScript({
    // Frame 0 only: subframe text is usually ads and chrome, and merging frames
    // produces context the user cannot locate on the page they are looking at.
    target: { tabId: tab.id, frameIds: [0] },
    func: scrapeInPage,
    args: [STRIP_SELECTOR],
  })
  const value = injection?.result as
    | { url: string; title: string; selection: string; raw: string }
    | undefined
  if (!value) throw new Error('Could not read the page contents.')

  const { text, truncated } = truncate(collapseWhitespace(value.raw), maxChars)
  return {
    url: value.url,
    title: value.title,
    selection: collapseWhitespace(value.selection),
    text,
    truncated,
  }
}
