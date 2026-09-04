/**
 * Capturing the visible page as a data URL.
 *
 * `chrome.tabs.captureVisibleTab` fails for reasons the caller (and the model)
 * can act on — the browser window is minimized, the tab sits on a
 * browser-internal page the host permissions do not cover, the per-second
 * capture quota trips, or the tab is mid-navigation. Collapsing every one of
 * those into a bare null (the previous behaviour) made every failure read as
 * the opaque "Could not capture the page.", so this module returns the
 * underlying reason and covers the recoverable cases itself.
 *
 * @module background/capture
 */

import { isInjectablePage } from '../lib/pages'
import type { ScopeWindow } from './automation-scope'
import { activeTab } from './page'

/** Capture outcome: a data URL, or the real reason the capture failed. */
export type CaptureResult = { ok: true; dataUrl: string } | { ok: false; error: string }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Maps a raw Chrome capture error onto a short actionable hint. Keyword-based
 * on purpose: Chrome does not type its capture errors, and the raw message is
 * always included alongside, so a missed keyword costs nothing.
 */
function captureHint(raw: string): string {
  const msg = raw.toLowerCase()
  if (msg.includes('max_capture_visible_tab_calls_per_second') || msg.includes('quota')) {
    return 'the per-second screenshot quota was hit — wait a moment and try again'
  }
  if (msg.includes('minim')) {
    return 'the browser window is minimized — restore it so there is something visible to capture'
  }
  if (msg.includes('<all_urls>') || msg.includes('activetab')) {
    return (
      "the extension manifest is missing the '<all_urls>' host permission that " +
      'captureVisibleTab requires — rebuild the bundle and reload the extension on chrome://extensions'
    )
  }
  if (
    msg.includes('cannot access') ||
    msg.includes('not allowed') ||
    msg.includes('permission') ||
    msg.includes('host')
  ) {
    return 'this page type is not capturable by the extension (browser-internal, local-file, or store pages) — switch to an ordinary http(s) page'
  }
  return ''
}

/**
 * Captures the active tab's visible area, surfacing the underlying Chrome
 * error (plus a hint) instead of an opaque null when it fails.
 *
 * Recoverable situations handled here:
 * - no active tab → a clear message instead of Chrome's cryptic rejection;
 * - browser-internal / local-file / store pages → refused up front (the
 *   manifest's host permissions only cover http/https, so the capture could
 *   only fail) with the reason spelled out;
 * - minimized window → restored and focused first, since a minimized window
 *   has no visible area to capture and the user asking for a screenshot wants
 *   exactly that;
 * - transient races (navigation commit, per-second quota) → one retry after a
 *   short delay before giving up with the raw error text.
 */
export async function captureVisiblePage(
  scope?: ScopeWindow,
  opts?: { format?: 'png' | 'jpeg'; quality?: number; tab?: chrome.tabs.Tab },
): Promise<CaptureResult> {
  // An explicit tab (resolved by the caller through resolveAutomationTab) wins:
  // the focused tab may be the workflow editor / popup itself, which must never
  // be the capture subject.
  const tab = opts?.tab ?? (await activeTab(scope))
  if (!tab || typeof tab.windowId !== 'number') {
    return {
      ok: false,
      error: 'No active tab to capture — open a page in a browser window first.',
    }
  }
  // A browser-internal/new-tab/file page can never be captured; refusing with
  // the reason up front beats Chrome's generic "cannot access" error.
  if (tab.url && !isInjectablePage(tab.url)) {
    return {
      ok: false,
      error:
        `Cannot capture ${tab.url}: browser-internal, local-file, and Web Store pages ` +
        'are off limits to extensions. Switch to an ordinary http(s) page and try again.',
    }
  }

  const windowId = tab.windowId
  try {
    const win = await chrome.windows.get(windowId)
    if (win.state === 'minimized') {
      await chrome.windows.update(windowId, { state: 'normal', focused: true })
      // Let the compositor actually paint before capturing, or the restored
      // window can still come back empty.
      await sleep(300)
    }
  } catch {
    // Window lookup/update is best-effort (and chrome.windows is absent in
    // some test doubles): fall through and let the capture report the real
    // error if it still fails.
  }

  const attempt = async (): Promise<string> =>
    chrome.tabs.captureVisibleTab(windowId, {
      format: opts?.format ?? 'png',
      ...(opts?.format === 'jpeg' ? { quality: opts.quality ?? 60 } : {}),
    })

  try {
    return { ok: true, dataUrl: await attempt() }
  } catch (first) {
    // One retry covers transient failures: a tab mid-navigation commit and a
    // just-exhausted per-second capture quota both succeed on a second try.
    await sleep(450)
    try {
      return { ok: true, dataUrl: await attempt() }
    } catch {
      const raw = first instanceof Error ? first.message : String(first)
      const hint = captureHint(raw)
      return { ok: false, error: `Screenshot failed: ${raw}${hint ? ` — ${hint}` : ''}` }
    }
  }
}
