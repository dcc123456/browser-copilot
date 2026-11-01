/**
 * Reports which selector candidates still match on the live web-chat page.
 *
 * This is the maintenance surface when a provider ships a redesign: the
 * adapter table is only as good as the DOM it names.
 *
 * @module background/web-chat/diagnose
 */
import type { WebChatDiagnosis, WebChatSelectorCheck, WebChatSiteId } from '../../lib/providers'
import { execOnActiveTab } from '../driver'
import { adapterFor, cssTarget } from './adapters'
import { ensureWebChatWindow } from './window'

export async function diagnoseWebChat(site: WebChatSiteId): Promise<WebChatDiagnosis> {
  const adapter = adapterFor(site)
  const ref = await ensureWebChatWindow(site)
  const tab = await chrome.tabs.get(ref.tabId).catch(() => undefined)

  const check = async (candidates: string[]): Promise<WebChatSelectorCheck[]> => {
    const checks: WebChatSelectorCheck[] = []
    for (const candidate of candidates) {
      const result = await execOnActiveTab(
        { action: 'element_exists', target: cssTarget([candidate]) },
        undefined,
        ref.tabId,
        ref.scope,
      ).catch(() => undefined)
      checks.push({
        candidate,
        found: result?.found === true,
        ...(typeof result?.matched === 'number' ? { matched: result.matched } : {}),
        ...(typeof result?.usedSpec === 'string' ? { usedSpec: result.usedSpec } : {}),
      })
    }
    return checks
  }

  return {
    site,
    url: tab?.url ?? '',
    title: tab?.title ?? '',
    windowId: ref.windowId,
    tabId: ref.tabId,
    selectors: {
      composer: await check(adapter.composer),
      send: await check(adapter.send),
      reply: await check(adapter.reply),
      stop: await check(adapter.stop),
      login: await check(adapter.login),
      newChat: await check(adapter.newChat),
    },
  }
}
