/**
 * Content-script delivery with reinjection.
 *
 * Every content script of this extension hears every tab message, so a
 * resolved `chrome.tabs.sendMessage` only proves that SOME listener is alive.
 * A tab opened before an extension (re)load can hold the picker launcher but
 * not the floating button (or the reverse); the old "does the send resolve?"
 * test then reported success and the missing script was never injected — a
 * minimized panel showed the crosshair with no restore button.
 *
 * The scripts therefore answer with an `{ ok: true }` receipt of their own.
 * Silence (undefined or a rejected send) means "this tab has no receiver":
 * the caller names the script file and it is injected on demand; that script
 * reports its own state on boot, so no further message is needed.
 *
 * @module background/content-script-delivery
 */

/**
 * Sends one control message to a tab. Returns whether the addressed content
 * script acknowledged it; when it did not, `scriptFile` (if given) is injected
 * into the tab so it can mount itself. Injection failures are swallowed: pages
 * that cannot host content scripts (chrome://, discarded tabs, no host access)
 * simply get no automation UI.
 */
export async function deliverToContentScript(
  tabId: number,
  message: unknown,
  scriptFile?: string,
): Promise<boolean> {
  const response = await chrome.tabs.sendMessage(tabId, message).catch(() => undefined)
  const delivered = (response as { ok?: boolean } | undefined)?.ok === true
  if (delivered || !scriptFile) return delivered
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [scriptFile] })
  } catch {
    /* page cannot host content scripts */
  }
  return false
}
