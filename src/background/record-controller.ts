/**
 * Workflow recording controller (service worker).
 *
 * On start, injects the in-page recorder into every injectable tab (and into
 * tabs opened/navigated while recording). Page events arrive as `record:event`
 * runtime messages and are appended to a linear flow list; the controller also
 * turns tab/URL events the page cannot see into blocks:
 *   - switching to another open tab            -> `switch-tab`
 *   - a new tab opened by a link/window.open   -> `new-tab`
 *   - a full-page navigation in the same tab   -> `open-url`
 *   - an SPA route change (pushState/replace)  -> `open-url`
 * The initial page load of tabs open at start is ignored; reloads and the
 * navigation implied by a recorded anchor click are de-duped. On stop, the
 * flows are converted into a saved workflow via flowsToWorkflow and the editor
 * opens it.
 *
 * @module background/record-controller
 */

import { startRecorder } from '../inpage/record'
import { isInjectablePage } from '../lib/pages'
import { flowsToWorkflow, type RecordedFlow } from '../lib/workflow/record-convert'
import { newId } from '../lib/storage'
import { saveWorkflow, getWorkflow } from '../lib/workflow/storage'

interface RecorderState {
  flows: RecordedFlow[]
  /**
   * Confined window, when the recorder was started scoped (the editor's host
   * window). Undefined = global recording (legacy behaviour). Events from
   * other windows are ignored while set.
   */
  windowId?: number
  /** URLs already turned into a navigation block (dedupe per frame). */
  seenNav: Set<string>
  /** Tab ids and their URL at the moment recording started (initial load). */
  initialTabs: Map<number, string>
  /** Tabs created while recording (target=_blank / window.open / a new tab). */
  newTabIds: Set<number>
  /** Epoch ms of the last recorded anchor-click (`link`) block. */
  lastLinkAt: number
  /** Epoch ms of the last navigation block we emitted (new-tab/open-url). */
  lastNavAt: number
  /** Index of the tab the last `switch-tab` block targeted (dedupe). */
  lastSwitchIndex: number | null
  badge?: chrome.action.TabIconDetails
}

let state: RecorderState | null = null

function setBadge(recording: boolean): void {
  try {
    void chrome.action.setBadgeText({ text: recording ? 'rec' : '' })
    if (recording) void chrome.action.setBadgeBackgroundColor({ color: '#ef4444' })
  } catch {
    /* action API unavailable in some contexts */
  }
}

async function injectIntoTab(tabId: number, url?: string): Promise<void> {
  if (!isInjectablePage(url)) return
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: startRecorder as unknown as (...args: unknown[]) => void,
      args: [{ recording: true }],
    })
  } catch {
    /* tab may have navigated away or be non-injectable; ignore */
  }
}

async function injectIntoAllTabs(windowId?: number): Promise<void> {
  const tabs = await chrome.tabs.query(windowId !== undefined ? { windowId } : {})
  await Promise.all(tabs.map((t) => (typeof t.id === 'number' ? injectIntoTab(t.id, t.url) : null)))
}

/**
 * @param windowId confine recording to this window's tabs (the editor's host
 *   window). Undefined keeps the legacy global recording.
 */
export async function startRecording(windowId?: number): Promise<void> {
  if (state) return
  const tabs = await chrome.tabs.query(windowId !== undefined ? { windowId } : {})
  const initialTabs = new Map<number, string>()
  for (const tab of tabs) {
    if (typeof tab.id === 'number') initialTabs.set(tab.id, tab.url ?? '')
  }
  state = {
    flows: [],
    ...(windowId !== undefined ? { windowId } : {}),
    seenNav: new Set(),
    initialTabs,
    newTabIds: new Set(),
    lastLinkAt: 0,
    lastNavAt: 0,
    lastSwitchIndex: null,
  }
  setBadge(true)
  await injectIntoAllTabs(windowId)
}

export async function stopRecording(): Promise<string | undefined> {
  if (!state) return undefined
  // The recorder's own scope (set at start) decides which tabs to clean up —
  // not the stop command's, so a scope change mid-recording cannot leak.
  const scopedWindowId = state.windowId
  const flows = state.flows
  const wf = flowsToWorkflow(flows)
  await saveWorkflow(wf)
  const finished = state
  state = null
  setBadge(false)
  // Stop the recorder in every tab.
  const tabs = await chrome.tabs.query(scopedWindowId !== undefined ? { windowId: scopedWindowId } : {})
  await Promise.all(
    tabs.map((t) =>
      typeof t.id === 'number'
        ? chrome.scripting
            .executeScript({
              target: { tabId: t.id, allFrames: false },
              func: startRecorder as unknown as (...args: unknown[]) => void,
              args: [{ recording: false }],
            })
            .catch(() => undefined)
        : null,
    ),
  )
  void finished
  return wf.id
}

export function isRecording(): boolean {
  return state !== null
}

function appendFlow(flow: RecordedFlow['data']): void {
  if (!state) return
  state.flows.push({ id: newId(), data: flow })
  // Remember anchor clicks so a same-tab link navigation that follows can be
  // recognized as the same action (avoiding a duplicate navigation block).
  if (flow.blockId === 'link') state.lastLinkAt = Date.now()
  if (flow.blockId === 'new-tab' || flow.blockId === 'open-url') state.lastNavAt = Date.now()
}

/** Window-relative index of a tab (what the `switch-tab` block replays). */
async function tabWindowIndex(tabId: number): Promise<number | null> {
  try {
    const target = await chrome.tabs.get(tabId)
    const siblings = await chrome.tabs.query({ windowId: target.windowId })
    const ordered = siblings
      .filter((t) => typeof t.id === 'number')
      .sort((a, b) => a.index - b.index)
    const found = ordered.findIndex((t) => t.id === tabId)
    return found >= 0 ? found : null
  } catch {
    return null
  }
}

/** Handle `record:event` messages from the injected page recorder. */
export function handleRecordEvent(message: unknown): boolean {
  const msg = message as { type?: string; flow?: RecordedFlow['data'] }
  if (msg.type === 'record:event' && msg.flow) {
    appendFlow(msg.flow)
    return true
  }
  return false
}

/**
 * Whether an event originating in `windowId` belongs to the active recording.
 * Unscoped recordings accept everything; scoped ones drop other windows.
 */
function scoped(windowId: number | undefined): boolean {
  if (!state) return false
  return state.windowId === undefined || state.windowId === windowId
}

/** Wire tab/navigation listeners. Call once at service-worker startup. */
export function initRecordingLifecycle(): void {
  // A tab opened while recording injects the recorder; its navigation is
  // captured below as a `new-tab` block (it has an opener).
  chrome.tabs.onCreated.addListener((tab) => {
    if (state && scoped(tab.windowId) && typeof tab.id === 'number') {
      // Remember tabs opened during recording so their navigation becomes a
      // `new-tab` block; a freshly opened tab is never an "initial" page.
      state.newTabIds.add(tab.id)
      state.initialTabs.delete(tab.id)
      void injectIntoTab(tab.id, tab.url)
    }
  })

  // Switching to an already-open tab becomes a `switch-tab` block so replay
  // follows the user across tabs (otherwise later steps would act on whichever
  // tab happened to be active). Fired when the user picks another tab.
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    if (!state) return
    void chrome.tabs.get(tabId).then((tab) => {
      if (state && scoped(tab?.windowId)) injectIntoTab(tabId, tab?.url)
    })
    if (!state) return
    // Ignore the activation caused by our own newly-opened navigation tab.
    if (Date.now() - state.lastNavAt < 1500) return
    void tabWindowIndex(tabId).then((index) => {
      if (!state || index === null) return
      if (state.lastSwitchIndex === index) return
      state.lastSwitchIndex = index
      appendFlow({
        blockId: 'switch-tab',
        index,
        waitTabLoaded: true,
        description: `切换到标签页 ${index + 1}`,
      })
    })
  })

  // Full-page navigation (server render, link that replaces the document, or
  // a typed URL). We did NOT previously see the change from the page context.
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (!state || details.frameId !== 0) return
    if (!scoped((details as { windowId?: number }).windowId)) return
    if (!isInjectablePage(details.url)) return
    if (details.transitionType === 'reload') return
    const key = `${details.tabId}:${details.url}`
    if (state.seenNav.has(key)) return

    // Skip the initial page load of tabs already open when recording began.
    if (
      state.initialTabs.has(details.tabId) &&
      state.initialTabs.get(details.tabId) === details.url
    ) {
      state.initialTabs.delete(details.tabId)
      state.seenNav.add(key)
      return
    }

    // A same-tab link navigation right after a recorded anchor click is the
    // same action — the `link` block already replays it. Don't double it up.
    const recentLink = Date.now() - state.lastLinkAt < 2500
    // A tab created while recording (target=_blank / window.open / a new tab)
    // records its first navigation as `new-tab`; once consumed it behaves like
    // any other in-place tab, so subsequent navigations become `open-url`.
    const isNewTab = state.newTabIds.has(details.tabId)

    state.seenNav.add(key)

    if (isNewTab) {
      state.newTabIds.delete(details.tabId)
      state.initialTabs.delete(details.tabId)
    }

    if (recentLink && !isNewTab) {
      // Same-tab link click: the recorded `link` block handles it; still
      // re-inject so subsequent interactions on the new page are captured.
      void injectIntoTab(details.tabId, details.url)
      return
    }

    state.initialTabs.delete(details.tabId)
    appendFlow({
      blockId: isNewTab ? 'new-tab' : 'open-url',
      url: details.url,
      waitTabLoaded: true,
      waitForSelector: true,
      waitSelectorTimeout: 10000,
      description: details.url,
    })
    // Re-inject recorder after the page context is replaced.
    void injectIntoTab(details.tabId, details.url)
  })

  // In-page (SPA) route changes: history.pushState/replaceState. These never
  // fire onCommitted, so without this listener clicking a client-side router
  // link changed the URL silently and the replayed workflow stayed on the old
  // page. `onHistoryStateUpdated` reports frame 0 for the top-frame change.
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (!state || details.frameId !== 0) return
    if (!scoped((details as { windowId?: number }).windowId)) return
    if (!isInjectablePage(details.url)) return
    // A same-tab link click already replayed via the `link` block; recording a
    // second navigation would duplicate it.
    if (Date.now() - state.lastLinkAt < 2500) return
    const key = `${details.tabId}:spa:${details.url}`
    if (state.seenNav.has(key)) return
    state.seenNav.add(key)
    appendFlow({
      blockId: 'open-url',
      url: details.url,
      waitTabLoaded: false,
      description: details.url,
    })
  })
}

/** Ensure a recorded workflow can be reopened (used by editor after stop). */
export async function ensureWorkflow(id: string): Promise<boolean> {
  const wf = await getWorkflow(id)
  return !!wf
}
