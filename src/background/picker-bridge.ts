/**
 * Element picker bridge (service worker).
 *
 * The editor popup requests element picking on the user's active tab; this
 * script injects the picker into that tab (all frames) and relays the result
 * back to the requesting editor window. Results arrive as runtime messages
 * from the injected picker and are forwarded by `pickerId`, so the editor
 * window can be behind the browser window without losing the result.
 *
 * @module background/picker-bridge
 */

import { startPicker } from '../inpage/element-picker'
import { isInjectablePage } from '../lib/pages'

interface PickerRequest {
  pickerId: string
  mode: 'select' | 'verify'
  findBy?: 'cssSelector' | 'xpath'
  selector?: string
  multiple?: boolean
}

/** pickerId -> requester (the editor tab/window that asked). */
const requesters = new Map<string, { tabId: number }>()

function pickerRequesterKey(pickerId: string): string {
  return `picker-req-${pickerId}`
}

/** Inject the picker into the active http(s) tab. */
async function injectPicker(args: PickerRequest, requesterTabId: number): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('No active tab to pick an element from.')
  }
  if (!isInjectablePage(tab.url)) {
    throw new Error('Elements can only be picked on ordinary http(s) pages.')
  }
  requesters.set(pickerRequesterKey(args.pickerId), { tabId: requesterTabId })
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: startPicker as unknown as (...args: unknown[]) => void,
    args: [args],
  })
}

/**
 * Wire picker messages. Call once from the service worker's onMessage handler.
 * Returns true (handled) for the picker message types.
 */
export function handlePickerMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): boolean {
  const msg = message as
    | { type: 'picker:start'; pickerId: string; findBy?: 'cssSelector' | 'xpath'; multiple?: boolean }
    | { type: 'picker:verify'; pickerId: string; selector: string; findBy?: 'cssSelector' | 'xpath' }
    | { type: 'picker:result'; pickerId: string; selector: string; count?: number; verified?: boolean; findBy?: string }
    | { type: 'picker:cancel'; pickerId: string }

  if (msg.type === 'picker:start') {
    const requesterTabId = sender.tab?.id ?? -1
    injectPicker({ pickerId: msg.pickerId, mode: 'select', findBy: msg.findBy, multiple: msg.multiple }, requesterTabId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    return true
  }

  if (msg.type === 'picker:verify') {
    const requesterTabId = sender.tab?.id ?? -1
    injectPicker(
      { pickerId: msg.pickerId, mode: 'verify', selector: msg.selector, findBy: msg.findBy ?? 'cssSelector' },
      requesterTabId,
    )
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    return true
  }

  if (msg.type === 'picker:result' || msg.type === 'picker:cancel') {
    // Forward to every extension page (the editor matches its own pickerId).
    void chrome.runtime.sendMessage(msg).catch(() => {
      /* no editor page open yet; result ignored */
    })
    sendResponse({ ok: true })
    requesters.delete(pickerRequesterKey(msg.pickerId))
    return false
  }

  return false
}
