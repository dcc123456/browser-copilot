/**
 * Workflow recording controller (service worker).
 *
 * On start, injects the in-page recorder into every injectable tab (and into
 * tabs opened/navigated while recording). Page events arrive as
 * `record:event` runtime messages and are appended to a linear flow list;
 * navigations (new tabs, committed/finished loads) become `new-tab` /
 * `link`-style blocks tracked via tabs + webNavigation. On stop, the flows are
 * converted into a saved workflow via flowsToWorkflow and the editor opens it.
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
  /** URLs already turned into a navigation block (dedupe per frame). */
  seenNav: Set<string>
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

async function injectIntoAllTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({})
  await Promise.all(tabs.map((t) => (typeof t.id === 'number' ? injectIntoTab(t.id, t.url) : null)))
}

export async function startRecording(): Promise<void> {
  if (state) return
  state = { flows: [], seenNav: new Set() }
  setBadge(true)
  await injectIntoAllTabs()
}

export async function stopRecording(): Promise<string | undefined> {
  if (!state) return undefined
  const flows = state.flows
  const wf = flowsToWorkflow(flows)
  await saveWorkflow(wf)
  const finished = state
  state = null
  setBadge(false)
  // Stop the recorder in every tab.
  const tabs = await chrome.tabs.query({})
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

/** Wire tab/navigation listeners. Call once at service-worker startup. */
export function initRecordingLifecycle(): void {
  chrome.tabs.onCreated.addListener((tab) => {
    if (state && typeof tab.id === 'number') void injectIntoTab(tab.id, tab.url)
  })
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    if (!state) return
    void chrome.tabs.get(tabId).then((tab) => injectIntoTab(tabId, tab.url))
  })
  // A committed navigation in a recorded tab becomes a new-tab block (page
  // reload / link navigation the recorder cannot see itself).
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (!state || details.frameId !== 0) return
    if (!isInjectablePage(details.url)) return
    const key = `${details.tabId}:${details.url}`
    if (state.seenNav.has(key)) return
    state.seenNav.add(key)
    // Only record navigations triggered by the user (link click / typed), not
    // the initial page load where recording began — approximated by skipping
    // the very first commit per tab after start.
    if (details.transitionType === 'reload') return
    appendFlow({
      blockId: details.transitionType === 'link' ? 'link' : 'new-tab',
      url: details.url,
      // Wait for the page to finish loading before the next recorded step
      // runs (Automa's "wait until the tab is loaded").
      waitTabLoaded: true,
      waitForSelector: true,
      waitSelectorTimeout: 10000,
      description: details.url,
    })
    // Re-inject recorder after the page context is replaced.
    void injectIntoTab(details.tabId, details.url)
  })
}

/** Ensure a recorded workflow can be reopened (used by editor after stop). */
export async function ensureWorkflow(id: string): Promise<boolean> {
  const wf = await getWorkflow(id)
  return !!wf
}
