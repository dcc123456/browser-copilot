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
export async function resolveAutomationTab(
  preferredTabId?: number,
): Promise<chrome.tabs.Tab | undefined> {
  if (typeof preferredTabId === 'number') {
    const pinned = await chrome.tabs.get(preferredTabId).catch(() => undefined)
    if (pinned && isInjectablePage(pinned.url)) return pinned
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
): Promise<OpResult> {
  const tab = await resolveAutomationTab(preferredTabId)
  if (!tab || typeof tab.id !== 'number' || !isInjectablePage(tab.url)) {
    throw new DriverError(
      '没有可操作的网页：请先在普通 http(s) 网页标签页上运行工作流（不能在扩展弹窗 / chrome:// 页面上执行页面操作）。',
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
    injections = await abortable(
      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        // Serialized as a bare function: the kernel source must not close over
        // anything. See src/inpage/kernel.ts.
        func: runOp as unknown as (...args: unknown[]) => unknown,
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
 * (tolerating an existing attachment), runs, and detaches; the queue makes
 * those sessions run one at a time.
 */
const cdpQueues = new Map<number, Promise<unknown>>()

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
    let attachedByUs = true
    try {
      const session: CdpSession = {
        send: (method: string, params?: Record<string, unknown>) =>
          chrome.debugger.sendCommand(target, method, params) as Promise<unknown>,
      }
      return await fn(session)
    } finally {
      // Only detach if we attached; another session may own a long-lived one.
      if (attachedByUs) {
        try {
          await chrome.debugger.detach(target)
        } catch {
          /* may already be detached */
        }
      }
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
export async function settleAfterNavigation(ms = 400, signal?: AbortSignal): Promise<void> {
  await sleep(ms, signal)
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

export async function goBack(): Promise<void> {
  const tab = await activeTab()
  if (!tab || typeof tab.id !== 'number') throw new DriverError('没有可后退的活动标签页')
  await chrome.tabs.goBack(tab.id)
}

export async function goForward(): Promise<void> {
  const tab = await activeTab()
  if (!tab || typeof tab.id !== 'number') throw new DriverError('没有可前进的活动标签页')
  await chrome.tabs.goForward(tab.id)
}

export interface DriverTabInfo {
  id: number
  url: string
  title: string
  active: boolean
}

export async function getActiveTabInfo(): Promise<DriverTabInfo> {
  const tab = await activeTab()
  if (!tab || typeof tab.id !== 'number') throw new DriverError('没有活动标签页')
  return toDriverTab(tab)
}

export async function listAllTabUrls(): Promise<{ id: number; url: string; title: string }[]> {
  const tabs = await chrome.tabs.query({ currentWindow: true })
  return tabs
    .filter((tab) => typeof tab.id === 'number')
    .map((tab) => ({ id: tab.id as number, url: tab.url ?? '', title: tab.title ?? '' }))
}

export async function newWindow(url?: string): Promise<chrome.windows.Window> {
  return chrome.windows.create({ url, focused: true })
}

/** Checks whether a CSS selector matches any element in the active tab. */
export async function elementExists(
  selector: string,
  signal?: AbortSignal,
): Promise<number> {
  const result = await execOnActiveTab({ action: 'element_exists', value: selector }, signal)
  return typeof result.data === 'number' ? result.data : result.found ? 1 : 0
}

/** Counts elements matching a CSS selector in the active tab. */
export async function countElements(
  selector: string,
  signal?: AbortSignal,
): Promise<number> {
  const result = await execOnActiveTab({ action: 'count_elements', value: selector }, signal)
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
): Promise<ExecJsResult> {
  const result = await execOnActiveTab(
    { action: 'exec_js', value: code, jsArgs: args, jsArgNames: Object.keys(args) },
    signal,
    preferredTabId,
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
): Promise<{ ok: true; data: WorkflowJsResult; logs: { level: string; message: string }[] } | { ok: false; error: string; logs: { level: string; message: string }[] }> {
  const result = await execOnActiveTab(
    {
      action: 'exec_workflow_js',
      value: code,
      jsArgs: { variables, timeout },
    },
    signal,
    preferredTabId,
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

// --- Clipboard helpers (offscreen document) ----------------------------------

let offscreenOpen = false

async function ensureOffscreen(): Promise<void> {
  const has = await chrome.offscreen.hasDocument()
  if (has) {
    offscreenOpen = true
    return
  }
  await chrome.offscreen.createDocument({
    url: 'src/offscreen/index.html',
    reasons: ['CLIPBOARD'],
    justification: 'read/write the system clipboard for the workflow clipboard block',
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
