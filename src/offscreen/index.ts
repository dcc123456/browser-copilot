/**
 * Offscreen document backing the `clipboard` workflow block.
 *
 * `navigator.clipboard.readText()` requires a focused document with the
 * `clipboardRead` permission and a user gesture in some Chrome versions, but an
 * offscreen document can serve the extension's own read/write needs without
 * disturbing the page the user is looking at. This page simply listens for
 * `clip-get` / `clip-set` messages and answers back with the text.
 *
 * @module offscreen/index
 */

void chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined
  if (message.type !== 'clip-get' && message.type !== 'clip-set') return undefined

  void (async () => {
    try {
      if (message.type === 'clip-get') {
        const text = await navigator.clipboard.readText()
        sendResponse({ ok: true, text })
      } else {
        await navigator.clipboard.writeText(String(message.text ?? ''))
        sendResponse({ ok: true })
      }
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()

  // Keep the message channel open until the async handler responds.
  return true
})