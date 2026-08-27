/**
 * Element picker bridge (service worker).
 *
 * The editor popup requests element picking on the user's active tab; this
 * script injects the picker into that tab and resolves the start/verify call.
 *
 * Result messages (`picker:result` / `picker:cancel`) are sent by the injected
 * picker via chrome.runtime.sendMessage. Because the picker runs in an
 * injected (content-script-like) isolated world, those messages are delivered
 * directly to every extension page — including the editor popup, which listens
 * for its own pickerId — so the background does NOT need to relay them (and
 * re-sending would re-enter the message listener). We simply acknowledge them.
 *
 * @module background/picker-bridge
 */

import { startPicker } from '../inpage/element-picker'
import { isInjectablePage } from '../lib/pages'

export interface PickerStartMessage {
  type: 'picker:start'
  pickerId: string
  findBy?: 'cssSelector' | 'xpath'
  multiple?: boolean
}
export interface PickerVerifyMessage {
  type: 'picker:verify'
  pickerId: string
  selector: string
  findBy?: 'cssSelector' | 'xpath'
}

/** Discriminated result of attempting to handle a message. */
export type PickerHandleResult =
  | { handled: false }
  | { handled: true; response: { ok: boolean; error?: string } }

/** Inject the picker into the active http(s) tab. */
async function injectPicker(args: {
  pickerId: string
  mode: 'select' | 'verify'
  findBy?: 'cssSelector' | 'xpath'
  selector?: string
  multiple?: boolean
}): Promise<{ ok: boolean; error?: string }> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab || typeof tab.id !== 'number') {
    return { ok: false, error: 'No active tab to pick an element from.' }
  }
  if (!isInjectablePage(tab.url)) {
    return { ok: false, error: 'Elements can only be picked on ordinary http(s) pages.' }
  }
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: startPicker as unknown as (...args: unknown[]) => void,
    args: [args],
  })
  return { ok: true }
}

/**
 * Handle a runtime message for the picker protocol. Returns a discriminated
 * result so the single background listener can route exactly one response.
 */
export async function handlePickerMessage(
  message: unknown,
): Promise<PickerHandleResult> {
  const msg = message as
    | PickerStartMessage
    | PickerVerifyMessage
    | { type: 'picker:result' | 'picker:cancel' }

  if (msg.type === 'picker:start') {
    const response = await injectPicker({
      pickerId: msg.pickerId,
      mode: 'select',
      findBy: msg.findBy,
      multiple: msg.multiple,
    })
    return { handled: true, response }
  }

  if (msg.type === 'picker:verify') {
    const response = await injectPicker({
      pickerId: msg.pickerId,
      mode: 'verify',
      selector: msg.selector,
      findBy: msg.findBy ?? 'cssSelector',
    })
    return { handled: true, response }
  }

  if (msg.type === 'picker:result' || msg.type === 'picker:cancel') {
    // Acknowledged for the page sender; the editor receives this message
    // directly via its own onMessage listener.
    return { handled: true, response: { ok: true } }
  }

  return { handled: false }
}
