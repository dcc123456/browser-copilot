/**
 * A model transport that drives a free, logged-in web chat in a background tab.
 *
 * The site exposes no API, so the extension acts like a user: reset the
 * conversation, type the flattened transcript, send it, and poll the last
 * assistant reply until it stops growing. There is no tool calling — the site
 * cannot receive `tools` — so callers gate this transport to chat and
 * text-only call sites.
 *
 * @module background/web-chat/transport
 */
import type { Messages } from '../../lib/i18n'
import type { StreamHandlers, StreamResult, WireMessage } from '../../lib/llm'
import { sleepWithSignal } from '../../lib/sleep'
import type { Op, OpResult } from '../../lib/ops'
import { webSiteOf, type ProviderProfile, type WebChatSiteId } from '../../lib/providers'
import { execOnActiveTab } from '../driver'
import { workerMessages } from '../worker-messages'
import { adapterFor, cssTarget, type WebChatAdapter } from './adapters'
import { buildWebChatPrompt, WebChatPromptError } from './prompt'
import {
  ensureWebChatWindow,
  openWebChatWindow,
  withWebChatLock,
  type WebChatWindowRef,
} from './window'

export type WebChatErrorCode =
  | 'attachments'
  | 'empty-reply'
  | 'login-required'
  | 'selector-missing'
  | 'timeout'
  | 'window-unavailable'

export class WebChatError extends Error {
  readonly code: WebChatErrorCode

  constructor(code: WebChatErrorCode, message: string) {
    super(message)
    this.name = 'WebChatError'
    this.code = code
  }
}

export interface WebChatCall {
  messages: WireMessage[]
  signal?: AbortSignal
  providerLabel?: string
}

export interface WebChatDeps {
  ensureWindow: (site: WebChatSiteId) => Promise<WebChatWindowRef>
  openWindow: (site: WebChatSiteId) => Promise<WebChatWindowRef>
  exec: typeof execOnActiveTab
  reload: (tabId: number, url: string) => Promise<void>
  messages: () => Promise<Messages>
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
}

const DEFAULT_DEPS: WebChatDeps = {
  ensureWindow: ensureWebChatWindow,
  openWindow: openWebChatWindow,
  exec: execOnActiveTab,
  reload: async (tabId, url) => {
    await chrome.tabs.update(tabId, { url })
  },
  messages: workerMessages,
  sleep: sleepWithSignal,
}

type RunOp = (op: Op, signal?: AbortSignal) => Promise<OpResult>

export async function streamWebChat(
  profile: ProviderProfile,
  call: WebChatCall,
  handlers: StreamHandlers = {},
  overrides: Partial<WebChatDeps> = {},
): Promise<StreamResult> {
  const site = webSiteOf(profile.baseUrl)
  if (!site) {
    throw new WebChatError(
      'selector-missing',
      'This web-chat provider does not point at a supported site.',
    )
  }
  const deps: WebChatDeps = { ...DEFAULT_DEPS, ...overrides }
  return withWebChatLock(site, async () => {
    try {
      return await run(site, call, handlers, deps)
    } catch (error) {
      if (error instanceof WebChatError || (error as Error)?.name === 'AbortError') throw error
      // The driver's "no operable page" wording is about browser tabs; in this
      // context it means the background chat window is gone or not injectable.
      const t = await deps.messages().catch(() => undefined)
      throw new WebChatError(
        'window-unavailable',
        t?.settingsWebChatWindowUnavailable ??
          'The web-chat window is unavailable. Switch to an API provider to chat inside the panel.',
      )
    }
  })
}

async function run(
  site: WebChatSiteId,
  call: WebChatCall,
  handlers: StreamHandlers,
  deps: WebChatDeps,
): Promise<StreamResult> {
  const t = await deps.messages()
  const adapter = adapterFor(site)
  const ref = await deps.ensureWindow(site)
  const runOp: RunOp = (op, signal) => deps.exec(op, signal, ref.tabId, ref.scope)

  const readiness = await waitReady(runOp, adapter, deps, call.signal)
  if (readiness === 'login') {
    await deps.openWindow(site)
    throw new WebChatError('login-required', t.settingsWebChatLoginRequired)
  }
  if (readiness !== 'ready') {
    throw new WebChatError('selector-missing', t.settingsWebChatSelectorMissing)
  }

  await resetConversation(runOp, adapter, ref, deps, call.signal, t)

  let prompt: string
  try {
    prompt = buildWebChatPrompt(call.messages)
  } catch (error) {
    if (error instanceof WebChatPromptError) {
      throw new WebChatError('attachments', t.settingsWebChatAttachmentsUnsupported)
    }
    throw error
  }

  const filled = await runOp(
    { action: 'fill', target: cssTarget(adapter.composer), value: prompt, clear: true },
    call.signal,
  )
  if (!filled.found) {
    throw new WebChatError('selector-missing', t.settingsWebChatSelectorMissing)
  }

  const baseline = await readReply(runOp, adapter, call.signal)
  await send(runOp, adapter, call.signal)

  const started = await waitForGenerationStart(runOp, adapter, baseline, deps, call.signal)
  if (!started) await send(runOp, adapter, call.signal)

  return observe(runOp, adapter, baseline, handlers, deps, call.signal, t)
}

async function waitReady(
  runOp: RunOp,
  adapter: WebChatAdapter,
  deps: WebChatDeps,
  signal?: AbortSignal,
): Promise<'ready' | 'login' | 'timeout'> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const composer = await runOp(
      { action: 'element_exists', target: cssTarget(adapter.composer) },
      signal,
    )
    if (composer.found) return 'ready'
    const login = await runOp(
      { action: 'element_exists', target: cssTarget(adapter.login) },
      signal,
    )
    if (login.found) return 'login'
    await deps.sleep(500, signal)
  }
  return 'timeout'
}

async function resetConversation(
  runOp: RunOp,
  adapter: WebChatAdapter,
  ref: WebChatWindowRef,
  deps: WebChatDeps,
  signal: AbortSignal | undefined,
  t: Messages,
): Promise<void> {
  if (adapter.newChat.length > 0) {
    const newChat = await runOp(
      { action: 'element_exists', target: cssTarget(adapter.newChat) },
      signal,
    )
    if (newChat.found) {
      await runOp({ action: 'click', target: cssTarget(adapter.newChat) }, signal)
      await deps.sleep(600, signal)
      return
    }
  }

  // No reset control: reload the site root so the next prompt starts a fresh
  // conversation instead of inheriting the previous one.
  await deps.reload(ref.tabId, adapter.url)
  await deps.sleep(1200, signal)
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const composer = await runOp(
      { action: 'element_exists', target: cssTarget(adapter.composer) },
      signal,
    )
    if (composer.found) return
    await deps.sleep(500, signal)
  }
  throw new WebChatError('selector-missing', t.settingsWebChatSelectorMissing)
}

async function send(runOp: RunOp, adapter: WebChatAdapter, signal?: AbortSignal): Promise<void> {
  if (adapter.send.length > 0) {
    const button = await runOp(
      { action: 'element_exists', target: cssTarget(adapter.send) },
      signal,
    )
    if (button.found) {
      const clicked = await runOp({ action: 'click', target: cssTarget(adapter.send) }, signal)
      if (clicked.ok) return
    }
  }
  await runOp({ action: 'press_key', value: 'Enter', target: cssTarget(adapter.composer) }, signal)
}

async function readReply(
  runOp: RunOp,
  adapter: WebChatAdapter,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runOp({ action: 'get_text', target: cssTarget(adapter.reply) }, signal)
  return result.found && typeof result.data === 'string' ? result.data : ''
}

async function waitForGenerationStart(
  runOp: RunOp,
  adapter: WebChatAdapter,
  baseline: string,
  deps: WebChatDeps,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const stop = await runOp({ action: 'element_exists', target: cssTarget(adapter.stop) }, signal)
    const text = await readReply(runOp, adapter, signal)
    if (stop.found || (text.length > 0 && text !== baseline)) return true
    await deps.sleep(250, signal)
  }
  return false
}

function appendedDelta(previous: string, next: string): string {
  return next.startsWith(previous) ? next.slice(previous.length) : next
}

async function observe(
  runOp: RunOp,
  adapter: WebChatAdapter,
  baseline: string,
  handlers: StreamHandlers,
  deps: WebChatDeps,
  signal: AbortSignal | undefined,
  t: Messages,
): Promise<StreamResult> {
  const startedAt = Date.now()
  let previous = baseline
  let content = ''
  let lastChange = Date.now()

  while (true) {
    if (signal?.aborted) {
      await stopGenerating(runOp, adapter).catch(() => undefined)
      throw new DOMException('Aborted', 'AbortError')
    }
    if (Date.now() - startedAt > 180_000) {
      throw new WebChatError('timeout', t.settingsWebChatTimeout)
    }

    const next = await readReply(runOp, adapter, signal)
    if (next !== previous) {
      const delta = appendedDelta(previous, next)
      if (delta) handlers.onText?.(delta)
      content = next
      previous = next
      lastChange = Date.now()
    }

    const stop = await runOp({ action: 'element_exists', target: cssTarget(adapter.stop) }, signal)
    const stableFor = Date.now() - lastChange
    if (content.length > 0 && !stop.found && stableFor >= 1500) break
    if (content.length > 0 && stop.found && stableFor >= 3000) break
    await deps.sleep(250, signal)
  }

  const finalText = content.trim()
  if (!finalText) throw new WebChatError('empty-reply', t.settingsWebChatEmptyReply)
  return {
    content: finalText,
    reasoning: '',
    toolCalls: [],
    finishReason: 'stop',
    usage: null,
  }
}

async function stopGenerating(runOp: RunOp, adapter: WebChatAdapter): Promise<void> {
  const stop = await runOp({ action: 'element_exists', target: cssTarget(adapter.stop) })
  if (stop.found) await runOp({ action: 'click', target: cssTarget(adapter.stop) })
}
