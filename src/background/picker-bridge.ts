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
import { resolveAutomationTab } from './driver'

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
  // Resolve the tab the user is actually automating, not the focused window's
  // active tab. The picker is launched from the standalone editor — a
  // chrome-extension:// popup — where `{active:true,lastFocusedWindow:true}`
  // returns the editor tab itself, which cannot be injected. resolveAutomationTab
  // skips extension pages and, when needed, falls back to the last viewed page.
  const tab = await resolveAutomationTab().catch(() => undefined)
  if (!tab || typeof tab.id !== 'number' || !isInjectablePage(tab.url)) {
    return {
      ok: false,
      error:
        '没有可拾取元素的网页：请先在普通 http(s) 网页标签页上使用拾取（不能在扩展弹窗 / chrome:// 页面上拾取）。',
    }
  }

  // Bring the target page to the foreground BEFORE injecting: the picker UI is
  // injected into that tab, but the click came from the standalone editor popup
  // (a separate window). Without focusing the page the picker card opens on a
  // background window the user never sees — the editor just looks stuck. This
  // mirrors Automa, which switches you to the automating tab to pick.
  try {
    if (typeof tab.windowId === 'number') {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    }
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {})
  } catch {
    /* focusing is best-effort; injection still proceeds */
  }

  try {
    // Top frame only: the picker card + overlay live in the main document.
    // Injecting every frame risks the whole call rejecting if any cross-origin
    // (e.g. about:blank / restricted) iframe throws, which would also strand the
    // editor's spinner.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: startPicker as unknown as (...args: unknown[]) => void,
      args: [args],
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `无法在该页面启动元素拾取：${msg}` }
  }
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
