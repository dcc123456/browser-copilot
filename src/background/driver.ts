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
import { KERNEL_VERSION } from '../inpage/kernel-version'
import { ensureTabMonitor, isMonitorHolding } from './cdp-monitor'
import type { ScopeWindow } from './automation-scope'
import type { Op, OpResult, PageSnapshot, SnapshotElement, Target } from '../lib/ops'
import { runOp, runExecJs, runWorkflowJs } from '../inpage/kernel'
import { activeTab } from './page'
import { getLastInjectableTab } from './last-tab'
import {
  clickClosedShadow,
  snapshotClosedShadow,
  type CdpSession,
} from './cdp-shadow'
import { fillViaCdp } from './cdp-typing'

/**
 * Resolve the tab a workflow should act on.
 *
 * A run launched from the editor popup or side panel has focus on an
 * extension page (`chrome-extension://…`), which cannot be scripted. In that
 * case fall back to the active tab of the most recently focused *normal*
 * browser window that is on an ordinary http(s) page. When the focused window
 * already shows an injectable page it is used directly.
 *
 * @param preferredTabId an optional tab pinned for this run (e.g. a tab a
 *   navigation block opened); it wins while still injectable.
 */
/**
 * Cached result of the last successful {@link resolveAutomationTab}. Re-running
 * the full active-tab search chain (activeTab → getLastFocused → windows.getAll
 * → tabs.query, each an IPC round trip) before EVERY op is wasted work while
 * the user has not touched focus. The cache is invalidated by any focus,
 * activation, removal or navigation event, so a stale hit structurally cannot
 * outlive the state it describes.
 */
let cachedAutomationTab: chrome.tabs.Tab | undefined
/**
 * The window scope the cache was resolved under. A cached tab from an
 * unscoped (unattended) run must never satisfy a panel-scoped call — that is
 * exactly the cross-window leak this module exists to prevent — so the cache
 * only hits when the scope key matches.
 */
let cachedAutomationScopeWindowId: number | undefined

function invalidateAutomationTabCache(): void {
  cachedAutomationTab = undefined
  cachedAutomationScopeWindowId = undefined
}

// Registered at import time, so guarded: unit tests import this module in a
// plain Node environment without a `chrome` global. Inside the service worker
// the listeners are always present.
if (typeof chrome !== 'undefined' && chrome.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener(invalidateAutomationTabCache)
  chrome.tabs.onRemoved.addListener(invalidateAutomationTabCache)
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (cachedAutomationTab?.id !== tabId) return
    // A URL change or a fresh load means the tab (and its frames) changed.
    if (changeInfo.url !== undefined || changeInfo.status === 'loading') {
      invalidateAutomationTabCache()
    }
  })
  chrome.windows.onFocusChanged.addListener(invalidateAutomationTabCache)
  chrome.windows.onRemoved.addListener(invalidateAutomationTabCache)
}

/**
 * A tab pinned by the `pin_tab` tool: every automation call acts on it until
 * `unpin` runs or the TTL expires (so a forgotten pin cannot hijack the next
 * session). Sits between an explicit per-call preferredTabId (which still
 * wins) and the passive resolution cache.
 *
 * The pin records its tab's WINDOW. A window-scoped run (`scope`) only honors
 * pins that live in ITS window — otherwise a pin from window A's session
 * would hijack window B's scoped resolution for the TTL duration, a real
 * cross-window leak. Unscoped (unattended) resolution honors any pin, as
 * before.
 */
const PIN_TTL_MS = 5 * 60_000
let pinnedTab: { id: number; windowId: number; at: number } | undefined

function setPinnedTab(tabId: number | undefined, windowId?: number): void {
  pinnedTab =
    tabId === undefined || typeof windowId !== 'number'
      ? undefined
      : { id: tabId, windowId, at: Date.now() }
  if (tabId !== undefined) {
    cachedAutomationTab = undefined // force a fresh resolution for the pin
  }
}

export async function resolveAutomationTab(
  preferredTabId?: number,
  scope?: ScopeWindow,
): Promise<chrome.tabs.Tab | undefined> {
  if (typeof preferredTabId === 'number') {
    const pinned = await chrome.tabs.get(preferredTabId).catch(() => undefined)
    if (pinned && isInjectablePage(pinned.url)) return pinned
  }

  // A `pin_tab` pin wins over everything but an explicit per-call tab —
  // but only within its own window for scoped runs.
  const pinUsable =
    pinnedTab !== undefined &&
    Date.now() - pinnedTab.at < PIN_TTL_MS &&
    (scope === undefined || pinnedTab.windowId === scope.windowId)
  if (pinUsable) {
    const pinned = await chrome.tabs.get(pinnedTab!.id).catch(() => undefined)
    if (pinned && isInjectablePage(pinned.url)) return pinned
    pinnedTab = undefined // pinned tab closed or became uninjectable
  } else if (pinnedTab && Date.now() - pinnedTab.at >= PIN_TTL_MS) {
    pinnedTab = undefined
  }

  // A cheap one-call existence check guards the cache; the event listeners
  // above are the primary invalidation path. The cache only hits when it was
  // resolved under the SAME window scope — a tab cached from an unscoped run
  // must not leak into a panel-scoped call, or vice versa.
  const scopeKey = scope?.windowId
  const cached = cachedAutomationTab
  if (cached && typeof cached.id === 'number' && cachedAutomationScopeWindowId === scopeKey) {
    const still = await chrome.tabs.get(cached.id).catch(() => undefined)
    if (still && isInjectablePage(still.url)) {
      cachedAutomationTab = still
      return still
    }
    cachedAutomationTab = undefined
  }

  const resolved = await resolveAutomationTabUncached(scope)
  if (resolved) {
    cachedAutomationTab = resolved
    cachedAutomationScopeWindowId = scopeKey
  }
  return resolved
}

/**
 * Uncached resolution chain. Prefer {@link resolveAutomationTab}, which wraps
 * this with event-invalidated caching.
 *
 * With a panel-window `scope`, resolution stays inside that window: its active
 * http(s) tab first, then the last http(s) tab remembered for that window. If
 * the window exists but has no injectable page, this returns undefined so
 * callers report a clear error — a scoped run must NEVER fall into another
 * window, which belongs to the user. If the scope window no longer exists
 * (closed mid-turn; the panel dies with it), resolution degrades to the
 * legacy global chain below.
 *
 * Unscoped (legacy) chain: a run launched from the editor popup or side panel
 * has focus on an extension page (`chrome-extension://…`), which cannot be
 * scripted. In that case fall back to the active tab of the most recently
 * focused *normal* browser window that is on an ordinary http(s) page. When
 * the focused window already shows an injectable page it is used directly.
 */
async function resolveAutomationTabUncached(scope?: ScopeWindow): Promise<chrome.tabs.Tab | undefined> {
  if (scope) {
    const win = await chrome.windows.get(scope.windowId).catch(() => undefined)
    if (win) {
      const [active] = await chrome.tabs
        .query({ active: true, windowId: scope.windowId })
        .catch(() => [])
      if (active && isInjectablePage(active.url)) return active
      const remembered = await getLastInjectableTab(undefined, scope.windowId).catch(
        () => undefined,
      )
      if (remembered) return remembered
      // The window exists but has no injectable page (all chrome:// etc.):
      // report "nothing to act on" rather than reaching into another window.
      return undefined
    }
    // Window gone: fall through to the legacy global chain.
  }

  const focused = await activeTab()
  const focusedWindowId = typeof focused?.windowId === 'number' ? focused.windowId : undefined
  if (focused && isInjectablePage(focused.url)) return focused

  // Focused window is an extension page / not injectable. Prefer the active tab
  // of the LAST FOCUSED *NORMAL* window — Automa's getActiveTab() does exactly
  // this. The standalone editor is opened as a `popup`-type window, so
  // getLastFocused({ windowTypes: ['normal'] }) structurally skips it and
  // returns the ordinary browser window the user was just looking at.
  const lastNormal = await chrome.windows
    .getLastFocused({ windowTypes: ['normal'], populate: true })
    .catch(() => undefined)
  if (lastNormal && typeof lastNormal.id === 'number') {
    const active = lastNormal.tabs?.find((t) => t.active)
    const candidate = active ?? lastNormal.tabs?.find((t) => isInjectablePage(t.url))
    if (candidate && isInjectablePage(candidate.url)) return candidate
  }

  // Fallback: search normal windows (most recently focused first) for their
  // active http(s) tab.
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => [])
  const sorted = (windows as chrome.windows.Window[]).slice().sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
  for (const win of sorted) {
    if (typeof win.id !== 'number') continue
    const tabs = await chrome.tabs.query({ windowId: win.id, active: true }).catch(() => [])
    const hit = tabs.find((t) => isInjectablePage(t.url))
    if (hit) return hit
  }
  // Any injectable active tab anywhere.
  const anyTabs = await chrome.tabs.query({ active: true }).catch(() => [])
  const anyHit = anyTabs.find((t) => isInjectablePage(t.url))
  if (anyHit) return anyHit

  // No injectable active tab (typically: launched from the standalone editor
  // popup, which is a chrome-extension:// window none of the active-tab queries
  // surface). Fall back to the last ordinary page the user actually viewed,
  // preferring the focused window. Never fall back to the extension tab itself
  // — acting on it fails with an opaque "only http(s) pages" error.
  const remembered = await getLastInjectableTab(focusedWindowId).catch(() => undefined)
  if (remembered) return remembered

  // Genuinely nothing to automate; return undefined so callers report a clear
  // error rather than trying to inject into the editor/extension page.
  return undefined
}

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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

/**
 * Races a pending operation against an abort signal so a long-running page call
 * (script injection, navigation settle) returns promptly when the user
 * terminates the run. The underlying Chrome call may still finish in the
 * background, but its result is ignored.
 */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error as Error)
      },
    )
  })
}

/** A driver error — something the harness owns, distinct from an op failure. */
export class DriverError extends Error {}

/** Element actions that benefit from an actionability pre-check. */
const PRECHECK_OPS = new Set(['click', 'fill', 'press_key', 'select_option', 'set_checkbox'])

/**
 * Waits until the target element is actionable before dispatching the real op
 * (the devtools-mcp/Puppeteer actionability pattern): the element must exist,
 * be visible, enabled and unoccluded, and its bounding box must be stable
 * across two consecutive samples ~120ms apart — a moving rect means an entry
 * animation is still running and a click would land in the void. Fail-open:
 * on probe failure or budget exhaustion the real op runs anyway and reports
 * its own error.
 */
async function waitForActionable(
  tabId: number,
  target: Target,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 1200
  let prevRect: string | null = null
  while (Date.now() < deadline) {
    if (signal?.aborted) return
    const result = await execOnActiveTab({ action: 'actionability', target }, signal, tabId).catch(
      () => undefined,
    )
    const data = result?.data as
      | { state?: 'ready' | 'blocked' | 'missing'; rect?: { x: number; y: number; w: number; h: number } }
      | undefined
    // Probe unsupported (old resident kernel) or the frame unscriptable —
    // the real op will report whatever is actually wrong.
    if (!data?.state) return
    if (data.state !== 'ready') {
      // Not rendered yet, hidden, disabled or occluded: give the page time.
      prevRect = null
      await sleep(120, signal).catch(() => {})
      continue
    }
    const key = data.rect ? `${data.rect.x},${data.rect.y},${data.rect.w},${data.rect.h}` : null
    if (key !== null && key === prevRect) return // stable across samples → go
    prevRect = key
    await sleep(120, signal).catch(() => {})
  }
}

/**
 * Serialized into every frame per op (fast path). Calls the kernel the
 * persistent content script parked on the ISOLATED world's global
 * (`__browserCopilotKernel`, see src/inpage/content-kernel.ts). Self-contained
 * by the kernel's "one rule": no references outside its own body. Returns
 * nothing in frames where the kernel is not resident — the driver re-injects
 * the full kernel into those frames.
 */
function runOpViaKernel(op: Op): OpResult | undefined {
  const g = globalThis as {
    __browserCopilotKernel?: (o: Op) => OpResult
    __browserCopilotKernelVersion?: number
  }
  // Version mismatch = a kernel from a previous extension build still resident
  // in this frame (reload/update with no navigation since). Treat it as absent:
  // the driver re-injects the fresh kernel, which overwrites the global.
  if (g.__browserCopilotKernelVersion !== KERNEL_VERSION) return undefined
  const kernel = g.__browserCopilotKernel
  if (typeof kernel !== 'function') return undefined
  return kernel(op)
}

/**
 * Runs one op on the active tab.
 *
 * @throws {DriverError} when there is no usable tab or injection fails for a
 *   reason other than an expected navigation.
 */
export async function execOnActiveTab(
  op: Op,
  signal?: AbortSignal,
  preferredTabId?: number,
  scope?: ScopeWindow,
): Promise<OpResult> {
  const tab = await resolveAutomationTab(preferredTabId, scope)
  if (!tab || typeof tab.id !== 'number' || !isInjectablePage(tab.url)) {
    throw new DriverError(
      scope
        ? '插件窗口内没有可操作的网页标签页（不跨窗口查找）。请先在插件窗口打开一个普通 http(s) 页面。'
        : '没有可操作的网页：请先在普通 http(s) 网页标签页上运行工作流（不能在扩展弹窗 / chrome:// 页面上执行页面操作）。',
    )
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  // User JavaScript runs in the page's MAIN world — the page's own JS context
  // (its window, page globals and libraries), the natural target for "run code
  // on this page". A static wrapper injection is CSP-exempt; compiling the
  // user's source inside it is governed by the page's CSP, like DevTools. We
  // run only the top frame: it is the document's own script context and avoids
  // re-running user code once per frame.
  if (op.action === 'exec_js') {
    return runJsInMainWorld(tab, op, signal)
  }
  if (op.action === 'exec_workflow_js') {
    return runWorkflowJsInMainWorld(tab, op, signal)
  }

  // Actions on elements inside a CLOSED shadow root cannot be performed by
  // in-page JS (the root is inaccessible); drive them through CDP trusted
  // input. Click/hover are supported; other targeted actions report a clear
  // error instead of the kernel's generic "not matched".
  // Element actions trigger fetches/animations whose events (console errors,
  // network state) the auto-observation wants to report. Attach the passive
  // monitor BEFORE the action so the events are captured from the start.
  // Best-effort and cheap when already attached; ops that only read stay out.
  if (
    typeof tab.id === 'number' &&
    (op.action === 'click' ||
      op.action === 'hover' ||
      op.action === 'fill' ||
      op.action === 'press_key' ||
      op.action === 'select_option' ||
      op.action === 'set_checkbox' ||
      op.action === 'scroll')
  ) {
    await ensureTabMonitor(tab.id).catch(() => {})
  }

  // Actionability pre-check: don't click into a moving/hidden/disabled
  // element — wait for readiness first (budget-capped, fail-open). Skipped
  // for closed-shadow targets, which take the CDP path below anyway.
  if (typeof tab.id === 'number' && PRECHECK_OPS.has(op.action) && op.target) {
    await waitForActionable(tab.id, op.target, signal)
  }

  if (typeof tab.id === 'number' && targetIsClosedShadow(op.target)) {
    if (op.action === 'click' || op.action === 'hover') {
      return runClosedShadowAction(tab.id, tab.url ?? '', op)
    }
    return {
      ok: false,
      found: true,
      frameUrl: tab.url ?? '',
      isTopFrame: true,
      error: `该元素位于封闭 Shadow DOM 中，暂不支持 ${op.action} 操作；可改用「JavaScript 代码」块在页面主世界执行。`,
    }
  }

  let injections: chrome.scripting.InjectionResult<unknown>[]
  try {
    // Fast path: the persistent content script (src/inpage/content-kernel.ts)
    // keeps the kernel resident in each frame's ISOLATED world, so this ships
    // only the op through a tiny trampoline instead of re-serializing the
    // whole kernel source into every frame on every op. Frames without a
    // resident kernel return no result and get the full kernel injected below.
    // Both functions are serialized as bare functions: no module-scope
    // closures. See src/inpage/kernel.ts.
    injections = await abortable(
      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: runOpViaKernel as unknown as (...args: unknown[]) => unknown,
        args: [op as unknown as never],
      }),
      signal,
    )
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
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

  // Cold frames: the content script has not run yet (fresh navigation racing
  // document_idle, extension just reloaded, bfcache restore). Prime them with
  // the full kernel injection, as the driver always did.
  const coldFrameIds = injections
    .filter((injection) => injection?.result == null && typeof injection.frameId === 'number')
    .map((injection) => injection.frameId)
  const warm = injections.filter((injection) => injection?.result != null)
  if (coldFrameIds.length > 0 && typeof tab.id === 'number') {
    try {
      const primed = await abortable(
        chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: coldFrameIds },
          func: runOp as unknown as (...args: unknown[]) => unknown,
          args: [op as unknown as never],
        }),
        signal,
      )
      warm.push(...primed)
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
      const message = error instanceof Error ? error.message : String(error)
      // A navigation during priming destroyed the context — treat like above.
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
      // Otherwise fall through with whatever warm frames answered; if none
      // did, the guard below raises the normal "could not be scripted" error.
    }
  }
  injections = warm

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
  const best = results[0] as OpResult

  // Stateful contenteditable editors (DraftJS — Zhihu articles — and friends)
  // keep their content in React state; when the kernel's simulated typing did
  // not register (data.registered === false), escalate to CDP trusted
  // keyboard input before reporting failure.
  const editableFallback =
    op.action === 'fill' && !best.ok && best.isTopFrame ? readEditableFallback(best) : null
  if (editableFallback && chrome.debugger && typeof tab.id === 'number') {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const text = op.value === undefined || op.value === null ? '' : String(op.value)
    try {
      const out = await withCdpSession(tab.id, (session) =>
        fillViaCdp(session, {
          selector: editableFallback.cssPath,
          text,
          clear: op.clear !== false,
        }),
      )
      if (out.ok) {
        return {
          ...best,
          ok: true,
          error: undefined,
          note: out.note ?? '已通过受信任键盘输入写入（chrome.debugger）',
        }
      }
      return {
        ...best,
        error: `${best.error ?? ''}（CDP 受信任键盘输入仍未成功：${out.error ?? '未知原因'}）`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ...best,
        error: `${best.error ?? ''}（CDP 受信任键盘输入失败：${message}）`,
      }
    }
  }

  // Enrich a snapshot with interactive elements hidden inside CLOSED shadow
  // roots (in-page JS never sees them). Best-effort: when the debugger is
  // unavailable or attaching fails, return the kernel snapshot unchanged.
  // They are PREPENDED and renumbered after the kernel elements so they never
  // fall beyond the model-facing element cap (shadowed controls are rare and
  // the whole reason for this enrichment).
  if (op.action === 'snapshot' && best.ok && best.page && chrome.debugger) {
    const extra = await readClosedShadowElements(tab.id)
    if (extra.length > 0) {
      const kernelCount = best.page.elements.length
      const renumbered = best.page.elements.map((el, i) => ({ ...el, ref: `e${i + 1}` }))
      const shadowEntries = extra.map((el, i) => ({ ...el, ref: `e${kernelCount + i + 1}` }))
      best.page = {
        ...best.page,
        elements: shadowEntries.concat(renumbered),
      }
    }
  }
  return best
}

/** Snapshot interactive elements inside closed shadow roots via CDP. */
async function readClosedShadowElements(tabId: number): Promise<SnapshotElement[]> {
  try {
    return await withCdpSession(tabId, (session) => snapshotClosedShadow(session, 1))
  } catch {
    // User dismissed the infobar / debugger policy / attach failed — degrade
    // silently: light-DOM and open-shadow elements are already in the snapshot.
    return []
  }
}

/** Run a click/hover on a closed-shadow element via CDP trusted input. */
async function runClosedShadowAction(
  tabId: number,
  frameUrl: string,
  op: Op,
): Promise<OpResult> {
  const base: OpResult = { ok: false, found: true, frameUrl, isTopFrame: true }
  if (!chrome.debugger) {
    return {
      ...base,
      found: false,
      error:
        '该元素位于封闭 Shadow DOM 中，需要调试器（chrome.debugger）权限才能操作；当前环境不可用。',
    }
  }
  try {
    const kind = op.action === 'hover' ? 'hover' as const : 'click' as const
    const out = await withCdpSession(tabId, (session) =>
      clickClosedShadow(session, op.target as Target, kind),
    )
    if (out.ok) {
      return { ...base, ok: true, note: out.note ?? '已操作（封闭 Shadow DOM）' }
    }
    return { ...base, found: false, error: out.error ?? '未能点击封闭 Shadow DOM 中的元素。' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ...base,
      found: false,
      error: `封闭 Shadow DOM 操作失败：${message}。可尝试在页面上用「JavaScript 代码」块直接操作，或允许扩展调试该标签页。`,
    }
  }
}

/**
 * Translate a thrown evaluation error into a clear message, recognizing CSP
 * blocks (the page forbids `unsafe-eval`).
 */
export function isCspBlocked(message: string): boolean {
  const m = message || ''
  return /content security policy|unsafe-eval|eval.*csp|evaluating a string|cannot call method.*eval|refused to evaluate a string/i.test(
    m,
  )
}

/** Whether the MAIN-world eval failed specifically because the page CSP forbids it. */
function explainJsError(message: string): string {
  const m = message || ''
  if (isCspBlocked(m)) {
    return (
      '该页面的内容安全策略（CSP）禁止执行自定义 JavaScript（未允许 unsafe-eval），无法在此页面运行 JS 代码。' +
      '请在未禁用页面脚本的普通网页上运行，或调整该页面的 CSP（如本地开发服务器可放宽 script-src）。'
    )
  }
  return m
}

/**
 * Extract the CDP fallback hint from a failed contenteditable fill. The
 * kernel returns the element's cssPath (computed while the element was in
 * hand) so the driver can re-resolve it inside the debugger session without
 * duplicating target resolution.
 */
function readEditableFallback(result: OpResult): { cssPath: string } | null {
  const data = result.data as
    | { contenteditable?: unknown; registered?: unknown; cssPath?: unknown }
    | undefined
  if (!data || typeof data !== 'object') return null
  if (data.contenteditable !== true || data.registered !== false) return null
  if (typeof data.cssPath !== 'string' || data.cssPath.length === 0) return null
  return { cssPath: data.cssPath }
}

/**
 * Whether a target lives inside a CLOSED shadow root (any spec so marked).
 * Such targets cannot be resolved by in-page JS; the driver routes them to
 * the chrome.debugger (CDP) channel.
 */
function targetIsClosedShadow(target: Target | undefined): boolean {
  if (!target) return false
  return [target.primary, ...(target.fallbacks ?? [])].some(
    (spec) => spec && (spec.how === 'cdp-shadow' || spec.closedShadow === true),
  )
}

/**
 * Serialize CDP sessions per tab so a CSP-fallback eval and a shadow click
 * never interleave attach/detach against the same target. Each caller attaches
 * (tolerating an existing attachment), runs, and hands the attachment to the
 * idle keep-alive below; the queue makes those sessions run one at a time.
 */
const cdpQueues = new Map<number, Promise<unknown>>()

/**
 * How long an attached debugger lingers after its last CDP command before it
 * detaches itself. Back-to-back CDP ops (contenteditable fill fallback, closed
 * shadow reads on consecutive snapshots, CSP evals) then skip the attach
 * handshake entirely, and the "extension is debugging this tab" infobar —
 * which flickers on every attach/detach cycle — stays up during a run and
 * disappears on its own once the tab has been idle for this long.
 */
const CDP_KEEP_ALIVE_MS = 10_000

const cdpKeepAlive = new Map<number, ReturnType<typeof setTimeout>>()

function scheduleCdpDetach(tabId: number): void {
  // The event monitor owns a long-lived attachment; our idle detach must not
  // reap it. The monitor detaches itself when its own idle timer expires.
  if (isMonitorHolding(tabId)) return
  const existing = cdpKeepAlive.get(tabId)
  if (existing) clearTimeout(existing)
  cdpKeepAlive.set(
    tabId,
    setTimeout(() => {
      cdpKeepAlive.delete(tabId)
      void chrome.debugger.detach({ tabId }).catch(() => {
        /* already detached (e.g. the user dismissed the infobar) */
      })
    }, CDP_KEEP_ALIVE_MS),
  )
}

function withCdpSession<T>(
  tabId: number,
  fn: (session: CdpSession) => Promise<T>,
): Promise<T> {
  const run = async (): Promise<T> => {
    const target = { tabId }
    try {
      await chrome.debugger.attach(target, '1.3')
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (!/already attached|already being debugged/i.test(msg)) throw error
    }
    // Whatever happens inside, the attachment is now ours to reap.
    try {
      const session: CdpSession = {
        send: (method: string, params?: Record<string, unknown>) =>
          chrome.debugger.sendCommand(target, method, params) as Promise<unknown>,
      }
      return await fn(session)
    } finally {
      scheduleCdpDetach(tabId)
    }
  }
  const prev = cdpQueues.get(tabId) ?? Promise.resolve()
  const next = prev.then(run, run)
  cdpQueues.set(
    tabId,
    next.finally(() => {
      if (cdpQueues.get(tabId) === next) cdpQueues.delete(tabId)
    }),
  )
  return next as Promise<T>
}

/**
 * Evaluate code in the page's MAIN world via the Chrome DevTools Protocol
 * (`chrome.debugger` + `Runtime.evaluate`). This is the CSP bypass Automa uses:
 * DevTools evaluation runs in the page's real JS context (so `window`, page
 * globals and the DOM are all visible) but is NOT governed by the page's CSP,
 * unlike `<script>`/`new Function` injected by `chrome.scripting` MAIN world.
 *
 * Attaching the debugger shows Chrome's "extension is debugging this tab"
 * infobar; we attach on demand and detach immediately after. Resolves the
 * JSON-serializable result value, or rejects with the runtime/attach error.
 */
async function evalViaCdp(tabId: number, expression: string): Promise<unknown> {
  return withCdpSession(tabId, async (session) => {
    const res = (await session.send('Runtime.evaluate', {
      expression,
      // Evaluate in the page's top frame MAIN world (the default context),
      // await Promises, and surface thrown errors as exceptionDetails.
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    })) as {
      result?: { type?: string; value?: unknown }
      exceptionDetails?: { exception?: { description?: string }; text?: string }
    }

    if (res.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ??
        res.exceptionDetails.text ??
        'JavaScript execution failed'
      throw new DriverError(desc.split('\n')[0] || desc)
    }
    return res.result?.value
  })
}

/**
 * Run a self-contained kernel harness function (e.g. `runWorkflowJs`) via CDP
 * in the page's MAIN world, returning its result. The function source is
 * serialized and invoked inside a `Runtime.evaluate` expression — it still
 * compiles user code internally, but that compilation happens under the
 * DevTools context which the page CSP cannot block.
 */
async function callHarnessViaCdp(
  tabId: number,
  fn: (...args: unknown[]) => unknown,
  arg: unknown,
): Promise<unknown> {
  // `await` because runWorkflowJs returns a Promise (awaited by CDP).
  const expression = `(${fn.toString()})(JSON.parse(${JSON.stringify(JSON.stringify(arg))}))`
  return evalViaCdp(tabId, expression)
}

/**
 * Inject `runExecJs` into the tab's MAIN world (top frame) and return an
 * OpResult-shaped outcome so callers of `execOnActiveTab`/`execJsOnActiveTab`
 * stay uniform.
 */
async function runJsInMainWorld(
  tab: chrome.tabs.Tab,
  op: Op,
  signal: AbortSignal | undefined,
): Promise<OpResult> {
  const frameUrl = tab.url ?? ''
  const base: OpResult = {
    ok: false,
    found: true,
    frameUrl,
    isTopFrame: true,
  }
  if (typeof tab.id !== 'number') return { ...base, error: '当前标签页无法执行脚本。' }
  try {
    const injections = await abortable(
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: runExecJs as unknown as (...args: unknown[]) => unknown,
        args: [
          {
            code: String(op.value ?? ''),
            argNames: Array.isArray(op.jsArgNames) ? op.jsArgNames : undefined,
            args: op.jsArgs ?? {},
          },
        ],
      } as unknown as chrome.scripting.ScriptInjection<unknown[], unknown>),
      signal,
    )
    const value = injections?.[0]?.result as
      | { ok: true; data?: unknown }
      | { ok: false; error?: string }
      | undefined
    if (!value) {
      return { ...base, error: 'JS 未返回结果（页面可能刚跳转）。' }
    }
    if (value.ok) return { ...base, ok: true, data: value.data }
    // MAIN-world eval blocked by the page CSP → fall back to CDP (Automa does
    // the same), which evaluates in the page context without obeying its CSP.
    if (value.error && isCspBlocked(value.error)) {
      const cdp = await runExecJsViaCdp(tab.id, op)
      if (cdp) return { ...base, ok: true, data: cdp.data }
      return { ...base, error: explainJsError(value.error) }
    }
    return { ...base, error: explainJsError(value.error ?? 'JavaScript execution failed') }
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    const message = error instanceof Error ? error.message : String(error)
    if (isContextLost(message)) {
      return {
        ok: true,
        found: true,
        frameUrl,
        isTopFrame: true,
        mayNavigate: true,
        note: 'The page navigated during this step.',
      }
    }
    // Injection itself can surface the CSP error in some builds; try CDP.
    if (isCspBlocked(message)) {
      const cdp = await runExecJsViaCdp(tab.id, op)
      if (cdp) return { ...base, ok: true, data: cdp.data }
    }
    return { ...base, error: explainJsError(message) }
  }
}

/**
 * Run the one-shot `runExecJs` expression/body harness through CDP as a CSP
 * fallback. Returns the harness's `{ ok, data }` or `null` when CDP is
 * unavailable/fails (so callers keep their normal error path).
 */
async function runExecJsViaCdp(
  tabId: number,
  op: Op,
): Promise<{ ok: true; data?: unknown } | null> {
  if (!chrome?.debugger) return null
  try {
    const result = (await callHarnessViaCdp(tabId, runExecJs as unknown as (...a: unknown[]) => unknown, {
      code: String(op.value ?? ''),
      argNames: Array.isArray(op.jsArgNames) ? op.jsArgNames : undefined,
      args: op.jsArgs ?? {},
    })) as { ok: true; data?: unknown } | { ok: false; error?: string } | undefined
    if (result && result.ok) return { ok: true, data: result.data }
    return null
  } catch {
    return null
  }
}

/**
 * Inject `runWorkflowJs` (async, Automa-helper harness) into the tab's MAIN
 * world for the workflow "JavaScript code" block and normalise the result.
 */
async function runWorkflowJsInMainWorld(
  tab: chrome.tabs.Tab,
  op: Op,
  signal: AbortSignal | undefined,
): Promise<OpResult> {
  const frameUrl = tab.url ?? ''
  const base: OpResult = { ok: false, found: true, frameUrl, isTopFrame: true }
  if (typeof tab.id !== 'number') return { ...base, error: '当前标签页无法执行脚本。' }
  try {
    const injections = await abortable(
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: runWorkflowJs as unknown as (...args: unknown[]) => unknown,
        args: [
          {
            code: String(op.value ?? ''),
            variables: (op.jsArgs?.['variables'] as Record<string, unknown>) ?? {},
            timeout: Number(op.jsArgs?.['timeout'] ?? 20000),
          },
        ],
      } as unknown as chrome.scripting.ScriptInjection<unknown[], unknown>),
      signal,
    )
    const value = injections?.[0]?.result as
      | { ok: true; data?: unknown; variables?: Record<string, unknown>; logs?: { level: string; message: string }[] }
      | { ok: false; error?: string; logs?: { level: string; message: string }[] }
      | undefined
    if (!value) return { ...base, error: 'JS 未返回结果（页面可能刚跳转）。' }
    if (value.ok) {
      // Carry the structured harness payload (result value, mutated variables,
      // captured console logs) back as the op's data.
      return {
        ...base,
        ok: true,
        data: { result: value.data, variables: value.variables, logs: value.logs ?? [] },
      }
    }
    // CSP blocked the MAIN-world compile → run the same harness via CDP.
    if (value.error && isCspBlocked(value.error)) {
      const cdp = await runWorkflowJsViaCdp(tab.id, op)
      if (cdp) return { ...base, ok: true, data: cdp }
    }
    return { ...base, error: explainJsError(value.error ?? 'JavaScript execution failed'), data: { logs: value.logs ?? [] } }
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    const message = error instanceof Error ? error.message : String(error)
    if (isCspBlocked(message)) {
      const cdp = await runWorkflowJsViaCdp(tab.id, op)
      if (cdp) return { ...base, ok: true, data: cdp }
    }
    return { ...base, error: explainJsError(message) }
  }
}

/** CSP fallback: run the async `runWorkflowJs` harness through CDP. */
async function runWorkflowJsViaCdp(
  tabId: number,
  op: Op,
): Promise<{ result?: unknown; variables?: Record<string, unknown>; logs: { level: string; message: string }[] } | null> {
  if (!chrome?.debugger) return null
  try {
    const value = (await callHarnessViaCdp(
      tabId,
      runWorkflowJs as unknown as (...a: unknown[]) => unknown,
      {
        code: String(op.value ?? ''),
        variables: (op.jsArgs?.['variables'] as Record<string, unknown>) ?? {},
        timeout: Number(op.jsArgs?.['timeout'] ?? 20000),
      },
    )) as
      | { ok: true; data?: unknown; variables?: Record<string, unknown>; logs?: { level: string; message: string }[] }
      | { ok: false }
      | undefined
    if (value && value.ok) {
      return { result: value.data, variables: value.variables, logs: value.logs ?? [] }
    }
    return null
  } catch {
    return null
  }
}

/** Convenience wrapper returning a structured snapshot. */
export async function snapshotActiveTab(
  maxChars = 8000,
  maxElements = 120,
  scope?: ScopeWindow,
): Promise<PageSnapshot> {
  const result = await execOnActiveTab({ action: 'snapshot', maxChars, maxElements }, undefined, undefined, scope)
  if (!result.page) throw new DriverError(result.error ?? 'The page could not be read.')
  return result.page
}

/**
 * Waits after a navigation so the next op sees the new document.
 *
 * Condition-based instead of a fixed sleep: watch `tabs.onUpdated` and return
 * as soon as the active tab reports `status === 'complete'`. If no load is in
 * progress, give the just-clicked control a brief window to kick one off — if
 * none starts, this was not a navigation after all and we return immediately.
 * The `ms` argument is a hard cap (2s default), never a fixed delay.
 */
export async function settleAfterNavigation(
  ms = 2000,
  signal?: AbortSignal,
  scope?: ScopeWindow,
): Promise<void> {
  const deadline = Date.now() + ms
  const remaining = (): number => Math.max(0, deadline - Date.now())

  const tab = await activeTab(scope).catch(() => undefined)
  if (!tab || typeof tab.id !== 'number') {
    await sleep(Math.min(400, ms), signal)
    return
  }
  const tabId = tab.id

  const waitComplete = (timeout: number): Promise<void> =>
    new Promise((resolve) => {
      if (timeout <= 0) {
        resolve()
        return
      }
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        chrome.tabs.onUpdated.removeListener(listener)
        clearTimeout(timer)
        resolve()
      }
      const listener = (id: number, info: chrome.tabs.TabChangeInfo): void => {
        if (id === tabId && info.status === 'complete') finish()
      }
      const timer = setTimeout(finish, timeout)
      chrome.tabs.onUpdated.addListener(listener)
    })

  if (tab.status === 'loading') {
    await abortable(waitComplete(remaining()), signal)
    return
  }

  // No load in progress: the navigation may not have started yet. Wait briefly
  // for a 'loading' event; if none arrives, return without waiting out the cap.
  const started = await new Promise<boolean>((resolve) => {
    const listener = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id === tabId && info.status === 'loading') finish(true)
    }
    const timer = setTimeout(() => finish(false), Math.min(150, remaining()))
    const finish = (v: boolean): void => {
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(timer)
      resolve(v)
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
  if (started) await abortable(waitComplete(remaining()), signal)
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

export async function listTabs(scope?: ScopeWindow): Promise<DriverTab[]> {
  // Scoped runs list only the panel window's tabs; unscoped keeps the legacy
  // "current window" (= last focused, in the service worker) behaviour.
  const tabs = await chrome.tabs.query(scope ? { windowId: scope.windowId } : { currentWindow: true })
  return tabs
    .filter((tab) => typeof tab.id === 'number')
    .map(toDriverTab)
    .sort((a, b) => a.id - b.id)
}

export async function switchTab(index: number, scope?: ScopeWindow): Promise<DriverTab> {
  const tabs = await listTabs(scope)
  const target = tabs[index]
  if (!target) {
    throw new DriverError(`No tab at index ${index}. This window has ${tabs.length} tab(s).`)
  }
  // Activates the tab inside its own window; this deliberately does NOT focus
  // the window, so a user working in another window is never interrupted.
  await chrome.tabs.update(target.id, { active: true })
  return target
}

export async function newTab(url?: string, scope?: ScopeWindow): Promise<DriverTab> {
  if (url && !isInjectablePage(url)) {
    throw new DriverError(`Cannot open "${url}": only http(s) pages can be automated.`)
  }
  // Scoped runs create the tab IN the panel window; unscoped keeps the legacy
  // "create in the current window" behaviour.
  const created = await chrome.tabs.create({
    url,
    active: true,
    ...(scope ? { windowId: scope.windowId } : {}),
  })
  return toDriverTab(created)
}

/**
 * Pins a tab (default: the current automation target) so every subsequent
 * automation call acts on it — no tab_switch round trips when the caller works
 * across several tabs. Auto-expires via the TTL in resolveAutomationTab.
 */
export async function pinActiveTab(tabId?: number, scope?: ScopeWindow): Promise<DriverTab> {
  const tab =
    typeof tabId === 'number'
      ? await chrome.tabs.get(tabId).catch(() => undefined)
      : await resolveAutomationTab(undefined, scope)
  if (!tab || typeof tab.id !== 'number' || !isInjectablePage(tab.url)) {
    throw new DriverError('pin_tab: 没有可钉住的 http(s) 标签页。')
  }
  setPinnedTab(tab.id, tab.windowId)
  return toDriverTab(tab)
}

/** Removes the pin; subsequent calls resolve the active tab again. */
export function unpinTab(): void {
  setPinnedTab(undefined)
}

export async function closeActiveTab(scope?: ScopeWindow): Promise<void> {
  const tab = await activeTab(scope)
  if (tab?.id) await chrome.tabs.remove(tab.id)
}

export async function goBack(scope?: ScopeWindow): Promise<void> {
  const tab = await activeTab(scope)
  if (!tab || typeof tab.id !== 'number') throw new DriverError('没有可后退的活动标签页')
  await chrome.tabs.goBack(tab.id)
}

export async function goForward(scope?: ScopeWindow): Promise<void> {
  const tab = await activeTab(scope)
  if (!tab || typeof tab.id !== 'number') throw new DriverError('没有可前进的活动标签页')
  await chrome.tabs.goForward(tab.id)
}

export interface DriverTabInfo {
  id: number
  url: string
  title: string
  active: boolean
}

export async function getActiveTabInfo(scope?: ScopeWindow): Promise<DriverTabInfo> {
  const tab = await activeTab(scope)
  if (!tab || typeof tab.id !== 'number') throw new DriverError('没有活动标签页')
  return toDriverTab(tab)
}

export async function listAllTabUrls(scope?: ScopeWindow): Promise<{ id: number; url: string; title: string }[]> {
  const tabs = await chrome.tabs.query(scope ? { windowId: scope.windowId } : { currentWindow: true })
  return tabs
    .filter((tab) => typeof tab.id === 'number')
    .map((tab) => ({ id: tab.id as number, url: tab.url ?? '', title: tab.title ?? '' }))
}

/**
 * Navigates the active tab to `url` — the `open_url` tool's primitive.
 *
 * Scoped runs target the panel window's active tab. Injectability is NOT
 * required here: navigating a `chrome://newtab` to an http(s) URL is a plain
 * `tabs.update`, which any tab accepts. Unscoped runs keep the legacy
 * "update the focused window's active tab" behaviour.
 */
export async function updateActiveTabUrl(url: string, scope?: ScopeWindow): Promise<void> {
  if (!scope) {
    await chrome.tabs.update({ url })
    return
  }
  const [tab] = await chrome.tabs
    .query({ active: true, windowId: scope.windowId })
    .catch(() => [])
  if (!tab || typeof tab.id !== 'number') {
    throw new DriverError('插件窗口内没有可导航的标签页。')
  }
  await chrome.tabs.update(tab.id, { url })
}

export async function newWindow(url?: string): Promise<chrome.windows.Window> {
  return chrome.windows.create({ url, focused: true })
}

/** Checks whether a CSS selector matches any element in the active tab. */
export async function elementExists(
  selector: string,
  signal?: AbortSignal,
  scope?: ScopeWindow,
): Promise<number> {
  const result = await execOnActiveTab({ action: 'element_exists', value: selector }, signal, undefined, scope)
  return typeof result.data === 'number' ? result.data : result.found ? 1 : 0
}

/** Counts elements matching a CSS selector in the active tab. */
export async function countElements(
  selector: string,
  signal?: AbortSignal,
  scope?: ScopeWindow,
): Promise<number> {
  const result = await execOnActiveTab({ action: 'count_elements', value: selector }, signal, undefined, scope)
  return typeof result.data === 'number' ? result.data : 0
}

/** Result of evaluating user JavaScript in the page. */
export interface ExecJsResult {
  ok: boolean
  data?: unknown
  error?: string
}

/**
 * Evaluate user JavaScript in the active tab's page (MAIN world).
 *
 * The MV3 service worker and offscreen document forbid `eval`/`new Function`
 * under their CSP, so workflow JS blocks and the agent's `run_javascript` tool
 * execute in the page itself. The wrapper is injected CSP-exempt into the MAIN
 * world; compiling the user source is governed by the page's CSP (like DevTools)
 * — pages without `unsafe-eval` report a clear error. `code` is a function body
 * (use `return` to send a value back); named `args` are parameters.
 */
export async function execJsOnActiveTab(
  code: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
  preferredTabId?: number,
  scope?: ScopeWindow,
): Promise<ExecJsResult> {
  const result = await execOnActiveTab(
    { action: 'exec_js', value: code, jsArgs: args, jsArgNames: Object.keys(args) },
    signal,
    preferredTabId,
    scope,
  )
  if (result.ok) return { ok: true, data: result.data }
  return { ok: false, error: result.error ?? 'JavaScript execution failed' }
}

/** Structured result of a workflow "JavaScript code" block. */
export interface WorkflowJsResult {
  /** Value passed to automaNextBlock / returned by the code. */
  result: unknown
  /** Variables the code set via automaSetVariable, merged into the run. */
  variables?: Record<string, unknown>
  /** console.* output captured while the code ran. */
  logs: { level: string; message: string }[]
}

/**
 * Run a workflow "JavaScript code" block in the page's MAIN world with the
 * Automa helper harness (automaNextBlock / automaSetVariable / automaRefData /
 * automaResetTimeout), captured console output, a timeout, and async support.
 */
export async function execWorkflowJsOnActiveTab(
  code: string,
  variables: Record<string, unknown>,
  timeout: number,
  signal?: AbortSignal,
  preferredTabId?: number,
  scope?: ScopeWindow,
): Promise<{ ok: true; data: WorkflowJsResult; logs: { level: string; message: string }[] } | { ok: false; error: string; logs: { level: string; message: string }[] }> {
  const result = await execOnActiveTab(
    {
      action: 'exec_workflow_js',
      value: code,
      jsArgs: { variables, timeout },
    },
    signal,
    preferredTabId,
    scope,
  )
  const captured =
    result.data && typeof result.data === 'object'
      ? (((result.data as { logs?: unknown }).logs as { level: string; message: string }[]) ?? [])
      : []
  if (result.ok) {
    const payload = result.data as Partial<WorkflowJsResult>
    return { ok: true, data: { result: payload.result, variables: payload.variables, logs: captured }, logs: captured }
  }
  return { ok: false, error: result.error ?? 'JavaScript execution failed', logs: captured }
}

// --- Cookie helpers (service-worker side, no page needed) --------------------

export async function cookieGetAll(url?: string): Promise<chrome.cookies.Cookie[]> {
  return chrome.cookies.getAll(url ? { url } : {})
}

export async function cookieGet(name: string, url?: string): Promise<chrome.cookies.Cookie | null> {
  const tab = await activeTab()
  const targetUrl = url ?? tab?.url
  if (!targetUrl) throw new DriverError('cookie: 需要 URL 才能读取')
  return chrome.cookies.get({ name, url: targetUrl })
}

export async function cookieSet(
  name: string,
  value: string,
  url: string,
  options: { expirationDate?: number } = {},
): Promise<void> {
  await chrome.cookies.set({
    url,
    name,
    value,
    ...(options.expirationDate !== undefined ? { expirationDate: options.expirationDate } : {}),
  })
}

export async function cookieRemove(name: string, url: string): Promise<void> {
  await chrome.cookies.remove({ name, url })
}

// --- Offscreen-document helpers (clipboard + local OCR) -----------------------

let offscreenOpen = false

async function ensureOffscreen(): Promise<void> {
  const has = await chrome.offscreen.hasDocument()
  if (has) {
    offscreenOpen = true
    return
  }
  // A single offscreen document serves both jobs, so every reason the page
  // uses (or will use) must be declared up front. WORKERS covers the
  // Tesseract.js worker that loads the WASM core for offline OCR.
  await chrome.offscreen.createDocument({
    url: 'src/offscreen/index.html',
    reasons: ['CLIPBOARD', 'WORKERS'],
    justification:
      'read/write the system clipboard for the workflow clipboard block and run the local OCR (Tesseract.js) worker',
  })
  offscreenOpen = true
}

interface ClipReply {
  ok: boolean
  text?: string
  error?: string
}

async function clipboardCall(message: { type: 'clip-get' } | { type: 'clip-set'; text: string }): Promise<string> {
  await ensureOffscreen()
  const reply = await chrome.runtime.sendMessage(message)
  const result = reply as ClipReply | undefined
  if (!result || !result.ok) {
    throw new DriverError(`clipboard: ${result?.error ?? '操作失败'}`)
  }
  return result.text ?? ''
}

export async function clipboardGet(): Promise<string> {
  return clipboardCall({ type: 'clip-get' })
}

export async function clipboardInsert(text: string): Promise<void> {
  await clipboardCall({ type: 'clip-set', text })
  void offscreenOpen
}

interface OcrReply {
  ok: boolean
  text?: string
  /** Tesseract confidence (0-100) for the returned text, when reported. */
  confidence?: number
  /** True when both segmentation passes normalized to the same reading. */
  agreed?: boolean
  /** Runner-up readings from the second segmentation pass, when they disagree. */
  alternatives?: string[]
  error?: string
}

/**
 * Runs local OCR (Tesseract.js) on a data URL in the offscreen document.
 * Returns the recognized text with its confidence and an agreement flag
 * (plus alternative readings when the two segmentation passes disagree), or
 * `{ ok: false, error }` when the worker could not load (e.g. the requested
 * language data is not vendored). Recognizes fully offline — no image model
 * or network required.
 */
export async function ocrImage(
  dataUrl: string,
  lang = 'eng',
): Promise<
  | { ok: true; text: string; confidence: number; agreed: boolean; alternatives?: string[] }
  | { ok: false; error: string }
> {
  await ensureOffscreen()
  const reply = await chrome.runtime.sendMessage({ type: 'ocr-image', image: dataUrl, lang })
  const result = reply as OcrReply | undefined
  if (!result || !result.ok) {
    return { ok: false, error: result?.error ?? 'OCR failed' }
  }
  return {
    ok: true,
    text: result.text ?? '',
    confidence: result.confidence ?? 0,
    agreed: result.agreed ?? false,
    ...(result.alternatives && result.alternatives.length > 0 ? { alternatives: result.alternatives } : {}),
  }
}

/**
 * Pre-loads the OCR worker (WASM compile + language model) in the offscreen
 * document so the first real `ocrImage` call skips the multi-second cold start.
 * Best effort: every failure is swallowed — warmup is purely an optimization
 * and the first `ocrImage` call would initialize the worker anyway.
 */
export async function warmupOcr(lang = 'eng'): Promise<void> {
  try {
    await ensureOffscreen()
    await chrome.runtime.sendMessage({ type: 'ocr-warm', lang })
  } catch {
    // Ignore: warmup must never break startup.
  }
}
