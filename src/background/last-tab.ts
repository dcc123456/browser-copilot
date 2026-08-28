/**
 * Tracks the most recently viewed ordinary http(s) tab.
 *
 * A workflow launched from the standalone editor — a `chrome-extension://`
 * popup window — has the editor as its "active" tab, and a popup window is not
 * returned by `chrome.windows.getAll({ windowTypes: ['normal'] })`. So when a
 * workflow's first page action runs from the editor, the driver's normal
 * tab resolution finds no injectable active tab and wrongly falls back to the
 * extension page, producing the opaque error "Cannot act on
 * chrome-extension://…".
 *
 * This module remembers the last injectable tab the user actually looked at
 * (across every normal window) by listening for tab activation / navigation,
 * giving the driver a sensible real page to fall back to. State lives in module
 * scope: it is disposable — if the worker is evicted the listeners re-fire and
 * the tracker repopulates.
 *
 * @module background/last-tab
 */

import { isInjectablePage } from '../lib/pages'

/** Candidate tab descriptors kept in most-recently-viewed order. */
interface LastTab {
  tabId: number
  windowId: number
  url: string
  updatedAt: number
}

/** Newest first. */
let recent: LastTab[] = []

const MAX_TRACKED = 12

function remember(tab: { id?: number; windowId?: number; url?: string }): void {
  if (typeof tab.id !== 'number' || typeof tab.windowId !== 'number') return
  const url = tab.url
  if (!isInjectablePage(url)) return
  recent = recent.filter((t) => t.tabId !== tab.id)
  recent.unshift({ tabId: tab.id, windowId: tab.windowId, url: url as string, updatedAt: Date.now() })
  if (recent.length > MAX_TRACKED) recent = recent.slice(0, MAX_TRACKED)
}

function forget(tabId: number): void {
  recent = recent.filter((t) => t.tabId !== tabId)
}

let listenersWired = false

/**
 * Wire the tracker to tab lifecycle events. Safe to call multiple times (it
 * binds once). Does nothing where `chrome.tabs` is unavailable (unit tests).
 */
export function initLastTabTracker(): void {
  if (listenersWired || typeof chrome === 'undefined' || !chrome.tabs) return
  listenersWired = true

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void chrome.tabs
      .get(tabId)
      .then((tab) => remember(tab))
      .catch(() => {})
  })

  // A tab navigating to a new URL becomes the current page for its window.
  chrome.tabs.onUpdated.addListener((_updatedTabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.status === 'loading') {
      remember(tab)
    }
  })

  chrome.tabs.onRemoved.addListener((removedTabId) => forget(removedTabId))

  // Seed with the currently active tab(s) at startup.
  void chrome.tabs
    .query({ active: true })
    .then((tabs) => tabs.forEach(remember))
    .catch(() => {})
}

/**
 * The most recently viewed injectable tab, preferring one in `preferWindowId`.
 * Validates the tab still exists and is still injectable (it may have closed or
 * navigated). Returns undefined when nothing usable is remembered.
 */
export async function getLastInjectableTab(preferWindowId?: number): Promise<chrome.tabs.Tab | undefined> {
  const ordered =
    typeof preferWindowId === 'number'
      ? [...recent].sort((a, b) => {
          if (a.windowId === preferWindowId && b.windowId !== preferWindowId) return -1
          if (b.windowId === preferWindowId && a.windowId !== preferWindowId) return 1
          return b.updatedAt - a.updatedAt
        })
      : recent

  for (const candidate of ordered) {
    const tab = await chrome.tabs.get(candidate.tabId).catch(() => undefined)
    if (tab && isInjectablePage(tab.url)) return tab
  }
  return undefined
}
