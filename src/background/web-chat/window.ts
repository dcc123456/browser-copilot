/**
 * The dedicated background window each free web chat runs in.
 *
 * A tab is required: Chrome cannot render a third-party site in an offscreen
 * document, and extension pages cannot read a cross-origin iframe. The window
 * is unfocused and reused across turns; per-site queues keep two requests from
 * typing into the same conversation at once.
 *
 * @module background/web-chat/window
 */
import type { WebChatSiteId } from '../../lib/providers'
import { normalScopeFromWindowId, type ScopeWindow } from '../automation-scope'
import { WEB_CHAT_ADAPTERS } from './adapters'

const STORAGE_KEY = 'bc:webChatTabs'

interface WebChatTabRef {
  windowId: number
  tabId: number
}

type WebChatTabMap = Partial<Record<WebChatSiteId, WebChatTabRef>>

let cache: WebChatTabMap = {}
let loaded = false
let listenersReady = false

const queues = new Map<WebChatSiteId, Promise<unknown>>()

/** Serializes work for one site; different sites may run concurrently. */
export function withWebChatLock<T>(site: WebChatSiteId, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(site) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  queues.set(site, next)
  return next.finally(() => {
    if (queues.get(site) === next) queues.delete(site)
  })
}

function ensureListeners(): void {
  if (listenersReady || typeof chrome === 'undefined') return
  listenersReady = true
  chrome.windows?.onRemoved?.addListener((windowId) => {
    for (const [site, ref] of Object.entries(cache)) {
      if (ref?.windowId === windowId) delete cache[site as WebChatSiteId]
    }
    void persist()
  })
  chrome.tabs?.onRemoved?.addListener((tabId) => {
    for (const [site, ref] of Object.entries(cache)) {
      if (ref?.tabId === tabId) delete cache[site as WebChatSiteId]
    }
    void persist()
  })
}

async function loadCache(): Promise<void> {
  if (loaded) return
  loaded = true
  ensureListeners()
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY)
    const value = stored?.[STORAGE_KEY]
    if (value && typeof value === 'object') cache = value as WebChatTabMap
  } catch {
    cache = {}
  }
}

async function persist(): Promise<void> {
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: cache })
  } catch {
    // Session storage can be unavailable during shutdown; the in-memory cache
    // still serves the current worker.
  }
}

export interface WebChatWindowRef {
  windowId: number
  tabId: number
  scope?: ScopeWindow
}

async function refOf(windowId: number, tabId: number): Promise<WebChatWindowRef> {
  return { windowId, tabId, scope: await normalScopeFromWindowId(windowId) }
}

export async function ensureWebChatWindow(site: WebChatSiteId): Promise<WebChatWindowRef> {
  await loadCache()
  const existing = cache[site]
  if (existing) {
    const window = await chrome.windows.get(existing.windowId).catch(() => undefined)
    const tab = await chrome.tabs.get(existing.tabId).catch(() => undefined)
    if (window && tab && tab.windowId === existing.windowId) {
      return refOf(existing.windowId, existing.tabId)
    }
    delete cache[site]
  }

  const adapter = WEB_CHAT_ADAPTERS[site]
  const created = await chrome.windows.create({
    url: adapter.url,
    focused: false,
    type: 'normal',
    width: 520,
    height: 820,
  })
  if (typeof created?.id !== 'number') {
    throw new Error('Could not open the web-chat window.')
  }
  const tabs = await chrome.tabs.query({ windowId: created.id })
  const tabId = tabs[0]?.id ?? created.tabs?.[0]?.id
  if (typeof tabId !== 'number') {
    throw new Error('Could not open the web-chat tab.')
  }
  cache[site] = { windowId: created.id, tabId }
  await persist()
  return refOf(created.id, tabId)
}

/** Brings the window forward so the user can sign in or solve a challenge. */
export async function openWebChatWindow(site: WebChatSiteId): Promise<WebChatWindowRef> {
  const ref = await ensureWebChatWindow(site)
  await chrome.windows.update(ref.windowId, { focused: true })
  await chrome.tabs.update(ref.tabId, { active: true })
  return ref
}
