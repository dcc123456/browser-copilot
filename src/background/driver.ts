/**
 * The browser driver: performs one op on the active tab, searching all frames.
 *
 * Unlike webtest-pilot, Browser Copilot always drives the tab the user is
 * looking at — there is no dedicated run window. A driver call therefore:
 *
 *  1. Resolves the active tab of the focused window.
 *  2. Injects the kernel with `allFrames: true`.
 *  3. Ranks results (`found` + `ok` + top frame) and returns the best one.
 *
 * A click that navigates destroys the injection context mid-call. Chrome
 * reports that as a generic "frame was removed" / "context invalidated"
 * error, which we treat as success: the click did in fact work.
 *
 * @module background/driver
 */

import { isInjectablePage } from '../lib/pages'
import type { Op, OpResult, PageSnapshot } from '../lib/ops'
import { runOp } from '../inpage/kernel'
import { activeTab } from './page'

/** Fragments Chrome produces when a navigation invalidated the context. */
const CONTEXT_LOST_PATTERNS = [
  'was removed',
  'context invalidated',
  'no frame with id',
  'frame was removed',
  'the message port closed',
  'no tab with id',
  'cannot access contents',
  'target closed',
]

function isContextLost(message: string): boolean {
  const lower = message.toLowerCase()
  return CONTEXT_LOST_PATTERNS.some((pattern) => lower.includes(pattern))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A driver error — something the harness owns, distinct from an op failure. */
export class DriverError extends Error {}

/**
 * Runs one op on the active tab.
 *
 * @throws {DriverError} when there is no usable tab or injection fails for a
 *   reason other than an expected navigation.
 */
export async function execOnActiveTab(op: Op): Promise<OpResult> {
  const tab = await activeTab()
  if (!tab || typeof tab.id !== 'number') {
    throw new DriverError('No active tab to operate on.')
  }
  if (!isInjectablePage(tab.url)) {
    throw new DriverError(
      `Cannot act on ${tab.url ?? 'this page'}: only ordinary http(s) pages can be automated.`,
    )
  }

  let injections: chrome.scripting.InjectionResult<unknown>[]
  try {
    injections = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      // Serialized as a bare function: the kernel source must not close over
      // anything. See src/inpage/kernel.ts.
      func: runOp as unknown as (...args: unknown[]) => unknown,
      args: [op as unknown as never],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isContextLost(message)) {
      return {
        ok: true,
        found: true,
        frameUrl: tab.url ?? '',
        isTopFrame: true,
        mayNavigate: true,
        note: 'The page navigated during this step.',
      }
    }
    throw new DriverError(`Could not run ${op.action}: ${message}`)
  }

  const results: OpResult[] = []
  for (const injection of injections) {
    const value = injection?.result as OpResult | undefined
    if (value && typeof value === 'object') results.push(value)
  }
  if (results.length === 0) {
    throw new DriverError('No frame in this tab could be scripted. The page may have just navigated.')
  }

  const rank = (result: OpResult): number =>
    (result.found ? 4 : 0) + (result.ok ? 2 : 0) + (result.isTopFrame ? 1 : 0)
  results.sort((a, b) => rank(b) - rank(a))
  return results[0] as OpResult
}

/** Convenience wrapper returning a structured snapshot. */
export async function snapshotActiveTab(
  maxChars = 8000,
  maxElements = 120,
): Promise<PageSnapshot> {
  const result = await execOnActiveTab({ action: 'snapshot', maxChars, maxElements })
  if (!result.page) throw new DriverError(result.error ?? 'The page could not be read.')
  return result.page
}

/**
 * Waits briefly after a navigation so the next op sees the new document.
 *
 * Deliberately short: the kernel itself re-resolves selectors, so a framework
 * that renders a moment after `load` is handled by the next op's own retry
 * rather than by sleeping here.
 */
export async function settleAfterNavigation(ms = 400): Promise<void> {
  await sleep(ms)
}

// --- Tab management ----------------------------------------------------------

export interface DriverTab {
  id: number
  url: string
  title: string
  active: boolean
}

function toDriverTab(tab: chrome.tabs.Tab): DriverTab {
  if (typeof tab.id !== 'number') throw new DriverError('Tab has no id.')
  return { id: tab.id, url: tab.url ?? '', title: tab.title ?? '', active: tab.active === true }
}

export async function listTabs(): Promise<DriverTab[]> {
  const tabs = await chrome.tabs.query({ currentWindow: true })
  return tabs
    .filter((tab) => typeof tab.id === 'number')
    .map(toDriverTab)
    .sort((a, b) => a.id - b.id)
}

export async function switchTab(index: number): Promise<DriverTab> {
  const tabs = await listTabs()
  const target = tabs[index]
  if (!target) {
    throw new DriverError(`No tab at index ${index}. This window has ${tabs.length} tab(s).`)
  }
  await chrome.tabs.update(target.id, { active: true })
  return target
}

export async function newTab(url?: string): Promise<DriverTab> {
  if (url && !isInjectablePage(url)) {
    throw new DriverError(`Cannot open "${url}": only http(s) pages can be automated.`)
  }
  const created = await chrome.tabs.create({ url, active: true })
  return toDriverTab(created)
}

export async function closeActiveTab(): Promise<void> {
  const tab = await activeTab()
  if (tab?.id) await chrome.tabs.remove(tab.id)
}
