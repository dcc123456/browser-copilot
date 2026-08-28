/**
 * Workflow block executors — the browser-class implementations.
 *
 * The engine contract: each block is an async function that receives the
 * node's `data` plus an execution context, and returns the id of the next node
 * to run (or `null` to let the engine follow the default single out-edge).
 *
 * Browser-class executors reuse `lib/ops` + `background/driver` instead of
 * re-implementing DOM logic. Non-browser blocks (data / control-flow /
 * integration / trigger) are registered as placeholders until phase 4 fills
 * them in.
 *
 * @module background/workflow-engine/executors
 */

import { isInjectablePage } from '../../lib/pages'
import { streamCompletion, type WireMessage } from '../../lib/llm'
import { getSettings } from '../../lib/storage'
import { interpolate } from '../../lib/workflow/interpolate'
import { aiAgent } from './ai-agent-executor'
import type { Op, ScrollSpec, Target } from '../../lib/ops'
import { activeTab } from '../page'
import {
  clipboardGet,
  clipboardInsert,
  closeActiveTab,
  cookieGet,
  cookieGetAll,
  cookieRemove,
  cookieSet,
  elementExists,
  execOnActiveTab,
  getActiveTabInfo,
  goBack,
  goForward,
  listAllTabUrls,
  newTab as driverNewTab,
  resolveAutomationTab,
  newWindow as driverNewWindow,
  switchTab as driverSwitchTab,
  execJsOnActiveTab,
  execWorkflowJsOnActiveTab,
} from '../driver'

/** Execution context handed to every block executor. */
export interface WorkflowExecCtx {
  /** Mutable variable storage, keyed by variable name. */
  variables: Record<string, unknown>
  /** The data-table current row (if table-backed). */
  refData: unknown
  signal: AbortSignal
  emit(kind: 'status' | 'result' | 'error' | 'info', text: string): void
  /**
   * The current block's output handles → target node ids, so branch blocks
   * (e.g. `condition`) can route to a specific edge by its handle id. The
   * default single out-edge is keyed as `'next'`.
   */
  outputs?: Record<string, string>
  /** The default out-edge target node id; used when the executor returns null. */
  defaultNext?: string | null
  /**
   * The tab this run is acting on. Undefined until resolved; navigation blocks
   * update it when they open/switch tabs so later steps follow the right page
   * instead of the extension popup that launched the run.
   */
  tabId?: number
  /** Pin the target tab (called by new-tab / link / switch-tab executors). */
  setTab?: (tabId: number) => void
  /**
   * Snapshot the current variables for a block (debug mode). Called by the
   * engine after each block; the run layer collects them so the logs viewer can
   * show the variable values at each step.
   */
  snapshot?: (nodeId: string, label: string, variables: Record<string, unknown>) => void
}

/**
 * A block execution step. Returns the next node id to route to (for explicit
 * selection like conditions); `null` means "follow the default single edge".
 */
export type BlockExecutor = (
  data: Record<string, unknown>,
  ctx: WorkflowExecCtx,
) => Promise<string | null>

// --- Helpers -----------------------------------------------------------------

/**
 * Read the element selector off a block's data, dual-supporting the Automa
 * shape (`selector` + `findBy: 'cssSelector'|'xpath'`) and the legacy MVP
 * shape (`cssSelector`).
 */
function sel(data: Record<string, unknown>): string {
  return (
    (typeof data['selector'] === 'string' && data['selector']) ||
    (typeof data['cssSelector'] === 'string' && data['cssSelector']) ||
    ''
  )
}

/** Build a CSS-only `Target` for the driver. */
function cssTarget(selector: string): Target {
  return { primary: { how: 'css', value: selector }, fallbacks: [] }
}

/**
 * Build a `Target` from a block's data. XPath locators are encoded with an
 * `xpath:` prefix the kernel resolves; CSS uses the css strategy.
 */
function targetFrom(data: Record<string, unknown>): Target {
  const selector = sel(data)
  if (data['findBy'] === 'xpath') {
    return { primary: { how: 'css', value: `xpath:${selector}` }, fallbacks: [] }
  }
  return cssTarget(selector)
}

/** Abort fast when the run was cancelled before this step started. */
function assertActive(ctx: WorkflowExecCtx): void {
  if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Evaluate user JavaScript in the page (the MV3 service worker forbids
 * `eval`/`new Function` under its CSP). Used by the JS code block and the
 * JS-expression blocks (conditions, data-mapping). Returns `{ ok, value }`;
 * on failure an error is emitted and `ok` is false so callers treat it as a
 * non-fatal block failure (consistent with the other executors).
 */
async function evalInPage(
  code: string,
  args: Record<string, unknown>,
  ctx: WorkflowExecCtx,
): Promise<{ ok: boolean; value?: unknown }> {
  try {
    const result = await execJsOnActiveTab(code, args, ctx.signal, ctx.tabId)
    if (result.ok) return { ok: true, value: result.data }
    ctx.emit('error', `JS 执行失败: ${result.error ?? '未知错误'}`)
    return { ok: false }
  } catch (error) {
    ctx.emit('error', `JS 执行失败: ${message(error)}`)
    return { ok: false }
  }
}

/**
 * Run one op on the active tab and report the outcome. A thrown error is
 * emitted (not swallowed) and the engine continues on the default edge.
 */
async function runRaw(op: Op, ctx: WorkflowExecCtx): Promise<string | null> {
  assertActive(ctx)
  try {
    const result = await execOnActiveTab(op, ctx.signal, ctx.tabId)
    ctx.emit('result', result?.note ?? 'ok')
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

/** Top-level injected function for the `get-text` block. No closure. */
function readTextInPage(selector: string): string {
  const el = document.querySelector(selector)
  return el ? (el.textContent ?? '').trim() : ''
}

// --- Browser executors -------------------------------------------------------

const click: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  return runRaw({ action: 'click', target: targetFrom(data) }, ctx)
}

const fill: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const value = String(data['value'] ?? '')
  return runRaw({ action: 'fill', target: targetFrom(data), value }, ctx)
}

const selectOption: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const value = String(data['value'] ?? '')
  return runRaw({ action: 'select_option', target: targetFrom(data), value }, ctx)
}

const scroll: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const mode = (data['mode'] as string | undefined) ?? 'into_view'
  const smooth = (data['scrollBehavior'] as string | undefined) === 'smooth'
  const x = Number(data['x'] ?? 0)
  const y = Number(data['y'] ?? 0)
  let scroll: ScrollSpec
  if (mode === 'by') scroll = { mode: 'by', x, y, smooth }
  else if (mode === 'incremental') scroll = { mode: 'incremental', x, y }
  else if (mode === 'top') scroll = { mode: 'top', smooth }
  else if (mode === 'bottom') scroll = { mode: 'bottom', smooth }
  else scroll = { mode: 'into_view' }

  const selector = sel(data)
  const op: Op = { action: 'scroll', scroll }
  if (selector) op.target = cssTarget(selector)

  // Incremental scroll = split the delta into small repeated steps so the page
  // scrolls a section at a time instead of one big jump.
  if (mode === 'incremental') {
    const step = Math.max(1, Number(data['step'] ?? 120))
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x), Math.abs(y)) / step))
    for (let i = 0; i < steps; i += 1) {
      assertActive(ctx)
      const safe = { ...op, scroll: { mode: 'by' as const, x: x / steps, y: y / steps, smooth: true } }
      try {
        await execOnActiveTab(safe, ctx.signal, ctx.tabId)
      } catch (error) {
        ctx.emit('error', message(error))
        break
      }
    }
    ctx.emit('result', `增量滚动完成`)
    return null
  }

  return runRaw(op, ctx)
}

const pressKey: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const key = String(data['key'] ?? '')
  ctx.emit('status', `按下按键: ${key}`)
  return runRaw({ action: 'press_key', value: key }, ctx)
}

const hover: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  return runRaw({ action: 'hover', target: targetFrom(data) }, ctx)
}

const setCheckbox: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const checked = (data['checked'] as boolean | undefined) ?? true
  return runRaw({ action: 'set_checkbox', target: targetFrom(data), value: checked }, ctx)
}

const waitFor: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  try {
    const result = await execOnActiveTab(
      { action: 'wait_for', target: targetFrom(data) },
      ctx.signal,
      ctx.tabId,
    )
    if (result?.found) ctx.emit('result', '元素已出现')
    else ctx.emit('error', '等待超时，元素未出现')
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

const takeScreenshot: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const type = (data['type'] as string | undefined) ?? 'page'
  const selector = sel(data)
  const variable = String(data['variableName'] ?? 'lastScreenshot')

  // fullpage / element go through the in-page SVG->canvas capture path.
  if (type === 'fullpage' || type === 'element') {
    try {
      const op: Op = { action: 'capture' }
      if (type === 'element') {
        if (!selector) {
          ctx.emit('error', '元素截图需要 CSS 选择器')
          return null
        }
        op.value = selector
      }
      const result = await execOnActiveTab(op, ctx.signal, ctx.tabId)
      if (result.ok && typeof result.data === 'string') {
        ctx.variables[variable] = result.data
        ctx.emit('result', `已截图 (${type})`)
      } else {
        ctx.emit('error', result.error ?? '截图失败')
      }
    } catch (error) {
      ctx.emit('error', message(error))
    }
    return null
  }

  // Default: visible page snapshot.
  const tab = await activeTab()
  if (!tab || typeof tab.id !== 'number') {
    ctx.emit('error', '没有可截图的活动标签页')
    return null
  }
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
    ctx.variables[variable] = dataUrl
    ctx.emit('result', '已截图')
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

const getText: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const selector = sel(data)
  const tab = await activeTab()
  if (!tab || typeof tab.id !== 'number') {
    ctx.emit('error', '没有活动标签页')
    return null
  }
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: readTextInPage,
    args: [selector],
  })
  const text = (injection?.result as string | undefined) ?? ''
  ctx.variables['lastText'] = text
  ctx.emit('result', text)
  return null
}

// --- Navigation executors ----------------------------------------------------

const openUrl: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const url = String(data['url'] ?? '')
  if (!isInjectablePage(url)) {
    ctx.emit('error', `仅允许打开 http(s) 页面: ${url}`)
    return null
  }
  const tab = await resolveAutomationTab(ctx.tabId)
  if (!tab || typeof tab.id !== 'number') {
    ctx.emit('error', '没有可操作的网页标签页')
    return null
  }
  await chrome.tabs.update(tab.id, { url })
  ctx.setTab?.(tab.id)
  await waitForTabLoaded(tab.id, ctx.signal)
  ctx.emit('result', `已打开 ${url}`)
  return null
}

const newTabExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const url = data['url'] ? String(data['url']) : undefined
  try {
    const tab = await driverNewTab(url)
    ctx.setTab?.(tab.id)
    if (url && data['waitTabLoaded'] !== false) {
      await waitForTabLoaded(tab.id, ctx.signal)
    }
    ctx.emit('result', `已新建标签页 #${tab.id}`)
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

const switchTabExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  try {
    const tab = await driverSwitchTab(Number(data['index'] ?? 0))
    ctx.setTab?.(tab.id)
    ctx.emit('result', `已切换到标签页 #${tab.id}`)
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

const closeTabExec: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  try {
    await closeActiveTab()
    ctx.emit('result', '已关闭当前标签页')
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

const reloadTabExec: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  const tab = await activeTab()
  if (!tab || typeof tab.id !== 'number') {
    ctx.emit('error', '没有活动标签页')
    return null
  }
  await chrome.tabs.reload(tab.id)
  ctx.emit('result', '已刷新当前标签页')
  return null
}

// --- Data / control-flow / integration executors -----------------------------

/** Resolve `ms` with abort support, so cancellation wakes a sleeping delay. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

const setVariable: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const name = String(data['variableName'] ?? '')
  const value = interpolate(String(data['value'] ?? ''), ctx.variables, ctx.refData)
  ctx.variables[name] = value
  ctx.emit('result', `已设置变量 ${name}`)
  return null
}

const getVariable: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const value = ctx.variables[String(data['variableName'] ?? '')]
  ctx.variables['lastValue'] = value
  ctx.emit('result', String(value ?? ''))
  return null
}

const insertData: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  let items: unknown[] = []
  try {
    const parsed = JSON.parse(String(data['data'] ?? '[]'))
    if (Array.isArray(parsed)) items = parsed
  } catch {
    /* malformed json → insert nothing */
  }
  if (!Array.isArray(ctx.variables['dataTable'])) ctx.variables['dataTable'] = []
  const table = ctx.variables['dataTable'] as unknown[]
  table.push(...items)
  ctx.emit('result', `已插入 ${items.length} 行`)
  return null
}

const exportData: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const table = Array.isArray(ctx.variables['dataTable'])
    ? (ctx.variables['dataTable'] as Record<string, unknown>[])
    : Array.isArray(ctx.refData)
      ? (ctx.refData as Record<string, unknown>[])
      : []
  const format = String(data['format'] ?? 'csv')
  let text = ''
  if (format === 'json') {
    text = JSON.stringify(table)
  } else if (table.length === 0) {
    text = ''
  } else {
    const header = Object.keys(table[0] as Record<string, unknown>)
    const cell = (value: unknown): string => {
      const raw = String(value ?? '')
      return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw
    }
    const rows = [header, ...table.map((row) => header.map((key) => cell(row[key])))]
    text = rows.map((row) => row.join(',')).join('\n')
  }
  ctx.variables['lastExport'] = text
  ctx.emit('result', text.slice(0, 80))
  return null
}

const condition: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const code = String(data['code'] ?? 'true')
  const evaluated = await evalInPage(`return (${code})`, { vars: ctx.variables, refData: ctx.refData }, ctx)
  const ok = evaluated.ok ? Boolean(evaluated.value) : false
  return ok
    ? (ctx.outputs?.['true'] ?? ctx.defaultNext ?? null)
    : (ctx.outputs?.['false'] ?? ctx.defaultNext ?? null)
}

const delay: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const ms = Number(data['ms'] ?? '500')
  await sleep(ms, ctx.signal)
  ctx.emit('status', `延时 ${ms}ms`)
  return null
}

const breakpoint: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  ctx.emit('info', '断点：执行暂停在此处')
  return null
}

const webhook: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const url = interpolate(String(data['url'] ?? ''), ctx.variables, ctx.refData)
  const method = String(data['method'] ?? 'POST').toUpperCase()
  const timeout = Math.max(0, Number(data['timeout'] ?? 30000))
  const responseVariable = String(data['responseVariable'] ?? 'lastHttpResponse')

  // Headers: interpolated JSON string, e.g. `{"Authorization":"Bearer ..."}`.
  let headers: Record<string, string> = { 'content-type': 'application/json' }
  const headersRaw = interpolate(String(data['headers'] ?? ''), ctx.variables, ctx.refData)
  if (headersRaw.trim()) {
    try {
      const parsed = JSON.parse(headersRaw)
      if (parsed && typeof parsed === 'object') headers = { ...headers, ...parsed } as Record<string, string>
    } catch {
      ctx.emit('error', 'webhook: headers 不是合法 JSON，使用默认头')
    }
  }

  // Body: interpolated JSON (or raw text). GET/HEAD send no body.
  let bodyText: string | undefined
  const rawBody = interpolate(String(data['body'] ?? ''), ctx.variables, ctx.refData)
  if (method !== 'GET' && method !== 'HEAD' && rawBody !== '') {
    let parsed: unknown = rawBody
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      /* fall back to the raw string */
    }
    bodyText = typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
  }

  try {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : undefined
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: bodyText,
        signal: controller.signal,
      })
      const responseText = await response.text()
      const record = {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseText,
      }
      ctx.variables[responseVariable] = record
      ctx.emit('result', `${method} ${response.status} ${responseText.slice(0, 80)}`)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  } catch (error) {
    if ((error as Error)?.name !== 'AbortError') ctx.emit('error', message(error))
    else ctx.emit('error', `${method} 请求超时或已取消`)
  }
  return null
}

const notification: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const title = interpolate(String(data['title'] ?? '通知'), ctx.variables, ctx.refData)
  const body = interpolate(String(data['message'] ?? ''), ctx.variables, ctx.refData)
  const api = typeof chrome !== 'undefined' ? chrome.notifications : undefined
  if (api) {
    try {
      await api.create({ type: 'basic', iconUrl: 'icons/icon-48.png', title, message: body })
    } catch (error) {
      ctx.emit('error', message(error))
    }
  } else {
    ctx.emit('info', '通知不可用')
  }
  ctx.emit('result', '已通知')
  return null
}

const javascriptCode: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const code = String(data['code'] ?? '')
  if (!code.trim()) {
    ctx.emit('error', 'javascript-code: 代码为空')
    return null
  }
  const timeout = Math.max(0, Number(data['timeout'] ?? 20000) || 20000)

  // Prefer the in-page harness (Automa helpers + console capture + page DOM).
  let run: Awaited<ReturnType<typeof execWorkflowJsOnActiveTab>> | null = null
  let triedPage = false
  // `chrome.scripting` exists in the real extension; in the pure-engine/tests it
  // does not, so we fall back to a local evaluation (see below).
  const hasPageBridge =
    typeof chrome !== 'undefined' && !!(chrome as { scripting?: unknown }).scripting
  if (hasPageBridge) {
    triedPage = true
    try {
      run = await execWorkflowJsOnActiveTab(code, ctx.variables, timeout, ctx.signal, ctx.tabId)
    } catch {
      run = null
    }
  }

  if (run && run.ok) {
    for (const line of run.logs ?? []) {
      ctx.emit(line.level === 'error' || line.level === 'warn' ? 'error' : 'info', line.message)
    }
    if (run.data.variables) {
      for (const [k, v] of Object.entries(run.data.variables)) ctx.variables[k] = v
    }
    const result = run.data.result
    ctx.variables['lastResult'] = result
    if (result !== undefined) {
      ctx.emit('result', typeof result === 'string' ? result : safeStringify(result))
    }
    return null
  }

  if (run) {
    // The harness ran and reported a clean failure (or page CSP/no-tab): surface
    // any captured console output, then fall through to local eval as a last
    // resort so simple expression bodies still work off-page.
    for (const line of run.logs ?? []) {
      ctx.emit(line.level === 'error' || line.level === 'warn' ? 'error' : 'info', line.message)
    }
  }

  // Fallback: evaluate locally in the worker (valid in Node tests; also used by
  // the agent's JS tooling). The page CSP restricts the *page*, not the worker —
  // but MV3 workers forbid eval, so this path only succeeds off-page.
  const local = await evalLocalWorkflowJs(code, ctx.variables, timeout)
  if (!local.ok) {
    if (triedPage) {
      ctx.emit('error', `javascript-code: ${run && !run.ok ? run.error : local.error}`)
    } else {
      ctx.emit('error', `javascript-code: ${local.error}`)
    }
    return null
  }
  for (const [k, v] of Object.entries(local.variables ?? {})) ctx.variables[k] = v
  ctx.variables['lastResult'] = local.result
  if (local.result !== undefined) {
    ctx.emit('result', typeof local.result === 'string' ? local.result : safeStringify(local.result))
  }
  return null
}

/** JSON.stringify that never throws (cyclic / bigint payloads). */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/**
 * Local (off-page) evaluation of a workflow JS body. Mirrors the harness contract
 * (`automaNextBlock` / `automaSetVariable` / `automaRefData`, `return`/await).
 * Used when no page bridge is available (pure-engine tests, worker contexts that
 * allow eval). Returns the result value and variables set by the code.
 */
async function evalLocalWorkflowJs(
  code: string,
  variables: Record<string, unknown>,
  timeout: number,
): Promise<{ ok: true; result?: unknown; variables?: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const working = { ...variables }
    let nextData: unknown
    let nextCalled = false
    const helpers = {
      automaNextBlock(data?: unknown) {
        nextCalled = true
        nextData = data
      },
      automaSetVariable(name: string, value: unknown) {
        working[String(name)] = value
      },
      automaRefData(keyword: string, path = '') {
        const root: Record<string, unknown> = {
          variables: working,
          table: working['dataTable'] ?? [],
          loopData: { loopIndex: working['loopIndex'], loopItem: working['loopItem'] },
          prevBlockData: working['lastResult'],
          globalData: working['globalData'] ?? {},
        }
        let value: unknown = root[keyword]
        for (const seg of String(path).split('.').filter(Boolean)) {
          if (value && typeof value === 'object') value = (value as Record<string, unknown>)[seg]
          else {
            value = undefined
            break
          }
        }
        return value
      },
      automaResetTimeout() {
        /* local eval runs to completion; timeout is a page-harness concern */
      },
    }

    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function(
      'automaNextBlock',
      'automaSetVariable',
      'automaRefData',
      'automaResetTimeout',
      'variables',
      `"use strict";\n${code}`,
    ) as (
      a: typeof helpers.automaNextBlock,
      b: typeof helpers.automaSetVariable,
      c: typeof helpers.automaRefData,
      d: typeof helpers.automaResetTimeout,
      v: Record<string, unknown>,
    ) => unknown

    const awaited = await Promise.race([
      Promise.resolve(fn(
        helpers.automaNextBlock,
        helpers.automaSetVariable,
        helpers.automaRefData,
        helpers.automaResetTimeout,
        working,
      )),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`JavaScript 代码超时（${timeout}ms）`)), Math.max(0, timeout) || 20000),
      ),
    ])
    return { ok: true, result: nextCalled ? nextData : awaited, variables: working }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const aiPrompt: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const prompt = interpolate(String(data['prompt'] ?? ''), ctx.variables, ctx.refData)
  const settings = await getSettings()
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId)
  if (!provider || !provider.apiKey.trim()) {
    ctx.emit('error', 'AI 块: 未配置模型给 provider')
    return null
  }
  const messages: WireMessage[] = [{ role: 'user', content: prompt }]
  try {
    const result = await streamCompletion({
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model: provider.model,
      messages,
      headers: provider.headers,
      signal: ctx.signal,
    })
    ctx.variables['lastAIResponse'] = result.content
    ctx.emit('result', result.content)
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

/** Launch triggers act as pass-through entry points in the browser build. */
const noop: BlockExecutor = async () => Promise.resolve(null)

// --- Phase 2: browser actions ----------------------------------------------

const cookieBlock: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const op = String(data['op'] ?? 'get')
  const name = interpolate(String(data['name'] ?? ''), ctx.variables, ctx.refData)
  const value = interpolate(String(data['value'] ?? ''), ctx.variables, ctx.refData)
  const url = interpolate(String(data['url'] ?? ''), ctx.variables, ctx.refData)
  const variable = String(data['variableName'] ?? 'lastCookie')
  try {
    if (op === 'getAll') {
      const cookies = await cookieGetAll(url || undefined)
      ctx.variables[variable] = cookies
      ctx.emit('result', `已读取 ${cookies.length} 个 Cookie`)
    } else if (op === 'get') {
      const cookie = await cookieGet(name, url || undefined)
      ctx.variables[variable] = cookie ? cookie.value : ''
      ctx.emit('result', cookie ? `已读取 ${name}` : `未找到 ${name}`)
    } else if (op === 'set') {
      if (!url) {
        ctx.emit('error', 'cookie: 写入需要 URL')
        return null
      }
      const expiry = Number(data['expirationDate'] ?? 0)
      await cookieSet(name, value, url, expiry > 0 ? { expirationDate: expiry } : {})
      ctx.emit('result', `已写入 ${name}`)
    } else if (op === 'remove') {
      if (!url) {
        ctx.emit('error', 'cookie: 删除需要 URL')
        return null
      }
      await cookieRemove(name, url)
      ctx.emit('result', `已删除 ${name}`)
    } else {
      ctx.emit('error', `cookie: 不支持的操作 ${op}`)
    }
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

const clipboardBlock: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const op = String(data['op'] ?? 'get')
  try {
    if (op === 'get') {
      const text = await clipboardGet()
      ctx.variables[String(data['variableName'] ?? 'lastClipboard')] = text
      ctx.emit('result', text.slice(0, 80))
    } else {
      const text = interpolate(String(data['text'] ?? ''), ctx.variables, ctx.refData)
      await clipboardInsert(text)
      ctx.emit('result', '已写入剪贴板')
    }
  } catch (error) {
    ctx.emit('error', `剪贴板 ${op}: ${message(error)}`)
  }
  return null
}

const elementExistsExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const count = await elementExists(sel(data), ctx.signal)
  const exists = count > 0
  ctx.emit('result', exists ? `元素存在 (${count})` : '元素不存在')
  return exists
    ? (ctx.outputs?.['exists'] ?? ctx.defaultNext ?? null)
    : (ctx.outputs?.['notExists'] ?? ctx.defaultNext ?? null)
}

const linkBlock: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const selector = sel(data)
  const newTab = (data['newTab'] as boolean | undefined) ?? true
  try {
    const result = await execOnActiveTab(
      { action: 'click_link', target: cssTarget(selector) },
      ctx.signal,
      ctx.tabId,
    )
    const info = result.data as { href?: string; target?: string } | undefined
    const href = info?.href ?? result.note ?? ''
    const waitLoaded = data['waitTabLoaded'] !== false
    if (newTab && info?.target === '_self') {
      if (href) {
        const tab = await driverNewTab(href)
        ctx.setTab?.(tab.id)
        if (waitLoaded) await waitForTabLoaded(tab.id, ctx.signal)
      }
      ctx.emit('result', `已在新标签页打开 ${href}`)
    } else {
      await execOnActiveTab(withWait({ action: 'click', target: cssTarget(selector) }, data), ctx.signal, ctx.tabId)
      if (waitLoaded) {
        const tab = await activeTab().catch(() => null)
        if (tab && typeof tab.id === 'number') await waitForTabLoaded(tab.id, ctx.signal)
      }
      ctx.emit('result', '已点击链接')
    }
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

const attributeValueExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const op = String(data['op'] ?? 'get')
  const attribute = String(data['attribute'] ?? '')
  const variable = String(data['variableName'] ?? 'lastAttribute')
  const opData: Op = {
    action: op === 'set' ? 'set_attribute' : 'get_attribute',
    target: targetFrom(data),
    attribute,
  }
  if (op === 'set') opData.value = interpolate(String(data['value'] ?? ''), ctx.variables, ctx.refData)
  try {
    const result = await execOnActiveTab(opData, ctx.signal, ctx.tabId)
    if (op === 'get') {
      ctx.variables[variable] = result.data ?? result.note ?? ''
      ctx.emit('result', String(result.data ?? result.note ?? ''))
    } else {
      ctx.emit('result', `已设置属性 ${attribute}`)
    }
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

const goBackExec: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  try {
    await goBack()
    ctx.emit('result', '已后退')
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

const forwardPage: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  try {
    await goForward()
    ctx.emit('result', '已前进')
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

const tabUrlExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const variable = String(data['variableName'] ?? 'lastTabUrl')
  try {
    const current = data['scope'] === 'all'
      ? await listAllTabUrls()
      : await getActiveTabInfo()
    ctx.variables[variable] = current
    ctx.emit('result', Array.isArray(current) ? `共 ${current.length} 个标签页` : current.url)
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

const activeTabExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const variable = String(data['variableName'] ?? 'lastActiveTab')
  try {
    const info = await getActiveTabInfo()
    ctx.variables[variable] = info
    ctx.emit('result', `${info.title} · ${info.url}`)
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

const newWindowExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const url = data['url'] ? interpolate(String(data['url']), ctx.variables, ctx.refData) : undefined
  try {
    await driverNewWindow(url)
    ctx.emit('result', '已打开新窗口')
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

const createElementExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const html = interpolate(String(data['html'] ?? ''), ctx.variables, ctx.refData)
  return runRaw({ action: 'create_element', value: html }, ctx)
}

const uploadFileExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const selector = sel(data)
  const dataUrl = interpolate(String(data['fileData'] ?? ''), ctx.variables, ctx.refData)
  try {
    // Conversion of arbitrary local files into an in-page File is not available
    // to MV3 extensions. We accept a data-url and hand it to the input; a
    // re-run against a blob/data URL produces a usable File for many pipelines.
    const opData: Op = { action: 'fill', target: cssTarget(selector), value: dataUrl }
    await execOnActiveTab(opData, ctx.signal, ctx.tabId)
    ctx.emit('result', '已设置文件输入')
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

const handleDialogExec: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  return runRaw({ action: 'handle_dialog' }, ctx)
}

// --- Phase 3: data / variable operations ------------------------------------

const increaseVariable: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const name = String(data['variableName'] ?? '')
  const step = Number(interpolate(String(data['value'] ?? '1'), ctx.variables, ctx.refData))
  const current = Number(ctx.variables[name] ?? data['incType'] === 'multiply' ? 1 : 0)
  const next = data['incType'] === 'multiply' ? current * step : current + step
  ctx.variables[name] = Number.isNaN(next) ? 0 : next
  ctx.emit('result', `${name} = ${next}`)
  return null
}

const sliceVariable: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const name = String(data['variableName'] ?? '')
  const start = Number(data['start'] ?? 0)
  const end = data['end'] === '' || data['end'] === undefined ? undefined : Number(data['end'])
  const value = ctx.variables[name]
  let sliced: unknown
  if (typeof value === 'string') sliced = value.slice(start, end)
  else if (Array.isArray(value)) sliced = value.slice(start, end)
  else sliced = value
  ctx.variables[String(data['output'] ?? name)] = sliced
  ctx.emit('result', String(sliced ?? ''))
  return null
}

const regexVariable: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const name = String(data['variableName'] ?? '')
  const pattern = String(data['pattern'] ?? '')
  const flags = String(data['flags'] ?? 'g')
  const replace = interpolate(String(data['replace'] ?? ''), ctx.variables, ctx.refData)
  const value = String(ctx.variables[name] ?? '')
  try {
    const regex = new RegExp(pattern, flags)
    let result: string
    if (data['operation'] === 'replace') result = value.replace(regex, replace)
    else {
      const flagsNoG = flags.replace('g', '')
      const matches = value.match(new RegExp(pattern, flagsNoG)) ?? []
      const all = flags.indexOf('g') !== -1 ? matches : [matches[0]].filter(Boolean)
      result = JSON.stringify(all.map((m) => String(m)))
    }
    ctx.variables[String(data['output'] ?? name)] = result
    ctx.emit('result', result.slice(0, 80))
  } catch (error) {
    ctx.emit('error', `regex: ${message(error)}`)
  }
  return null
}

/** Shared dataTable getter with a default empty array. */
function tableOf(ctx: WorkflowExecCtx): unknown[] {
  return Array.isArray(ctx.variables['dataTable']) ? (ctx.variables['dataTable'] as unknown[]) : []
}

const deleteDataExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const target = tableOf(ctx)
  const key = Number(data['key'] ?? -1)
  const all = data['clearAll'] === true
  if (all) ctx.variables['dataTable'] = []
  else if (key >= 0 && key < target.length) target.splice(key, 1)
  ctx.emit('result', all ? '已清空数据表' : `已删除第 ${key} 行`)
  return null
}

const sortDataExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const target = (ctx.variables['dataTable'] as Record<string, unknown>[]) ?? []
  const field = String(data['field'] ?? '')
  const direction = String(data['direction'] ?? 'asc') === 'desc' ? -1 : 1
  const sorted = [...target].filter((row) => row && typeof row === 'object')
  sorted.sort((a, b) => {
    const va = field ? a[field] : a['value']
    const vb = field ? b[field] : b['value']
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * direction
    return String(va ?? '').localeCompare(String(vb ?? '')) * direction
  })
  ctx.variables['dataTable'] = sorted
  ctx.emit('result', `已按 ${field || '值'} 排序`)
  return null
}

const dataMapping: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const rows = tableOf(ctx).filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
  const expression = String(data['mapping'] ?? 'item')
  // Map every row in ONE page injection (rather than one eval per row). The
  // expression is evaluated with `item`, `index`, and `vars` in scope.
  const wrapped = `return rows.map((item, index) => (${expression}));`
  const evaluated = await evalInPage(wrapped, { rows, vars: ctx.variables }, ctx)
  if (!evaluated.ok) {
    ctx.emit('error', 'data-mapping: 映射表达式执行失败')
    return null
  }
  const mapped = Array.isArray(evaluated.value) ? evaluated.value : []
  ctx.variables[String(data['output'] ?? 'mappedData')] = mapped
  ctx.variables['lastMappedData'] = mapped
  ctx.emit('result', `已映射 ${mapped.length} 行`)
  return null
}

const logData: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const text = interpolate(String(data['text'] ?? ''), ctx.variables, ctx.refData)
  ctx.emit('info', text)
  return null
}

const workflowState: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const op = String(data['op'] ?? 'get')
  const variable = String(data['variableName'] ?? 'state')
  if (op === 'set') {
    const value = interpolate(String(data['value'] ?? ''), ctx.variables, ctx.refData)
    ctx.variables[variable] = value
    ctx.emit('result', `已设置状态 ${variable}`)
  } else {
    const value = ctx.variables[variable]
    ctx.variables['lastState'] = value
    ctx.emit('result', String(value ?? ''))
  }
  return null
}

// --- Phase 5: integration / service blocks ----------------------------------

const parameterPrompt: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const prompt = interpolate(String(data['prompt'] ?? '请输入值'), ctx.variables, ctx.refData)
  const fallback = interpolate(String(data['defaultValue'] ?? ''), ctx.variables, ctx.refData)
  // Engine is autonomous; surface the prompt and fall back to the default or
  // an existing variable of the same name so workflows that pre-seed input work.
  const variable = String(data['variableName'] ?? 'userInput')
  if (ctx.variables[variable] === undefined && fallback !== '') ctx.variables[variable] = fallback
  ctx.emit('info', `需要输入：${prompt}`)
  ctx.emit('result', String(ctx.variables[variable] ?? ''))
  return null
}

const switchToExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  // The driver already searches all frames; record the iframe target as context.
  const frame = String(data['frameSelector'] ?? '')
  ctx.emit('info', frame ? `已定位 iframe ${frame}` : '已定位到顶层页面')
  return null
}

const triggerEventExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const event = String(data['event'] ?? '')
  const detail = interpolate(String(data['detail'] ?? 'null'), ctx.variables, ctx.refData)
  return runRaw({ action: 'trigger_event', target: targetFrom(data), attribute: event, value: detail }, ctx)
}

const browserEvent: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  ctx.emit('info', 'browser-event: 页面事件监听需常驻 content script，当前为占位实现')
  return null
}

const handleDownload: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const filename = String(data['filename'] ?? '')
  const variable = String(data['variableName'] ?? 'lastDownload')
  try {
    const items = await chrome.downloads.search({})
    const match = filename
      ? items.find((item) => item.filename.includes(filename))
      : items[0]
    ctx.variables[variable] = match ? { id: match.id, filename: match.filename, url: match.url } : null
    ctx.emit('result', match ? `最近下载: ${match.filename}` : '未找到匹配下载')
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

const saveAssetsExec: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  ctx.emit('info', 'save-assets: 资源保存需工作区目标，当前为占位实现')
  return null
}

const proxyExec: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  ctx.emit('info', 'proxy: 代理配置需浏览器级设置，当前为占位实现')
  return null
}

const googleSheets: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  ctx.emit('error', 'google-sheets: 需要 OAuth 凭据，尚未配置')
  return null
}

const googleDrive: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  ctx.emit('error', 'google-drive: 需要 OAuth 凭据，尚未配置')
  return null
}

const waitConnections: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  ctx.emit('info', 'wait-connections: 等待网络连接，当前为占位实现')
  return null
}

const note: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const text = String(data['text'] ?? '')
  if (text) ctx.emit('info', text)
  return null
}

const blocksGroup: BlockExecutor = async (_data) => {
  // A group is a structural container — its body routes via its outgoing edge.
  return null
}

// --- Phase 1: form reading / radio ------------------------------------------

const getForm: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const variable = String(data['variableName'] ?? 'lastForm')
  const selector = sel(data) || undefined
  try {
    const op: Op = { action: 'read_form' }
    if (selector) op.value = selector
    const result = await execOnActiveTab(op, ctx.signal, ctx.tabId)
    ctx.variables[variable] = result.data ?? {}
    ctx.emit('result', JSON.stringify(result.data ?? {}).slice(0, 80))
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
}

const selectRadio: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const checked = data['value'] !== '' && data['value'] !== false
  return runRaw({ action: 'set_checkbox', target: targetFrom(data), value: checked }, ctx)
}

// --- Placeholders for engine-handled blocks ----------------------------------

/** Emit an "info" notice and let the engine continue. */
function placeholder(blockId: string): BlockExecutor {
  return (_data, ctx) => {
    ctx.emit('info', '尚未实现: ' + blockId)
    return Promise.resolve(null)
  }
}

/** Apply Automa's waitForSelector/waitSelectorTimeout to an op. */
function withWait<T extends Op>(op: T, data: Record<string, unknown>): T {
  if (data['waitForSelector'] === true) {
    op.waitFor = Number(data['waitSelectorTimeout'] ?? 5000)
  }
  return op
}

/**
 * Automa's "wait until the tab is loaded": after a navigation block opens a
 * URL, wait for that tab to reach status 'complete'. The tab id is optional
 * (defaults to the active tab); waits up to ~15s.
 */
async function waitForTabLoaded(tabId: number | undefined, signal?: AbortSignal): Promise<void> {
  if (typeof tabId !== 'number' || !chrome?.tabs?.onUpdated) return
  const check = await chrome.tabs.get(tabId).catch(() => null)
  if (check?.status === 'complete') return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      signal?.removeEventListener('abort', cancel)
      resolve()
    }, 15000)
    const cancel = () => {
      clearTimeout(timeout)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timeout)
        chrome.tabs.onUpdated.removeListener(listener)
        signal?.removeEventListener('abort', cancel)
        resolve()
      }
    }
    signal?.addEventListener('abort', cancel, { once: true })
    chrome.tabs.onUpdated.addListener(listener)
  })
}

/** Automa `forms` block: text/select/checkbox/radio input on one selector. */
const formsBlock: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const type = String(data['type'] ?? 'text-field')
  const value = data['value']
  const target = targetFrom(data)

  if (type === 'checkbox' || type === 'radio') {
    const checked = typeof value === 'boolean' ? value : true
    return runRaw(withWait({ action: 'set_checkbox', target, value: checked }, data), ctx)
  }
  if (type === 'select') {
    return runRaw(withWait({ action: 'select_option', target, value: String(value ?? '') }, data), ctx)
  }
  return runRaw(
    withWait({ action: 'fill', target, value: String(value ?? ''), clear: data['clearValue'] !== false }, data),
    ctx,
  )
}

/** Automa `element-scroll` block: scroll an element or the window by X/Y. */
const elementScroll: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const x = Number(data['scrollX'] ?? 0)
  const y = Number(data['scrollY'] ?? 0)
  const smooth = data['smooth'] === true
  const selector = sel(data)
  if (!selector || selector === 'window' || selector === 'html') {
    return runRaw({ action: 'scroll', scroll: { mode: 'by', x, y, smooth } }, ctx)
  }
  if (data['scrollIntoView']) {
    return runRaw(withWait({ action: 'scroll', target: targetFrom(data), scroll: { mode: 'into_view' } }, data), ctx)
  }
  return runRaw(
    withWait({ action: 'scroll', target: targetFrom(data), scroll: { mode: 'by', x, y, smooth } }, data),
    ctx,
  )
}

/**
 * Automa `conditions` block: named output groups each with AND-ed rows; the
 * groups are OR-ed. A truthy group routes to output-1 (true), otherwise
 * output-2 (false). Falls back to a `code` expression for the older shape.
 */
const conditionsBlock: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const code = data['code'] as string | undefined
  let matched = false
  if (code) {
    const evaluated = await evalInPage(
      `return (${code})`,
      { vars: ctx.variables, refData: ctx.refData },
      ctx,
    )
    matched = evaluated.ok ? Boolean(evaluated.value) : false
  } else {
    // Evaluate condition rows: a group is true when all its rows compare true.
    const groups = (data['conditions'] as { conditions?: ConditionRow[] }[] | undefined) ?? []
    matched = groups.some(
      (g) =>
        Array.isArray(g.conditions) &&
        g.conditions.length > 0 &&
        g.conditions.every((row) => evalConditionRow(row, ctx.variables)),
    )
  }
  ctx.emit('result', matched ? '条件成立' : '条件不成立')
  return matched
    ? (ctx.outputs?.['true'] ?? ctx.outputs?.['output-1'] ?? ctx.defaultNext ?? null)
    : (ctx.outputs?.['false'] ?? ctx.outputs?.['output-2'] ?? ctx.defaultNext ?? null)
}

interface ConditionRow {
  /** Value type (value/element data/...); here we interpret `value` literals. */
  type?: string
  /** Automa compare operator: eql, nq, cnt, contains, exists, ... */
  compare?: string
  value?: unknown
  /** Variable name referenced by the row, when type is a data lookup. */
  name?: string
}

/** Evaluate one Automa condition row against runtime variables. */
function evalConditionRow(row: ConditionRow, vars: Record<string, unknown>): boolean {
  const left = row.name !== undefined && row.name !== '' ? vars[row.name] : row.value
  const right = row.value
  const present = left !== undefined && left !== null && left !== ''
  switch (row.compare ?? '') {
    case 'nq':
    case 'not-exists':
    case 'not-visible':
      return !present
    case 'exists':
    case 'visible':
    case 'visible-screen':
      return present
    case 'cnt':
    case 'contains':
      return String(left ?? '').includes(String(right ?? ''))
    case 'nct':
      return !String(left ?? '').includes(String(right ?? ''))
    case 'gt':
      return Number(left) > Number(right)
    case 'gte':
      return Number(left) >= Number(right)
    case 'lt':
      return Number(left) < Number(right)
    case 'lte':
      return Number(left) <= Number(right)
    case 'eql':
    case 'eq':
    default:
      // Equality with type coercion for numbers, else string compare.
      if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right)
      return String(left ?? '') === String(right ?? '')
  }
}

/** Automa `event-click` / `hover-element` respect waitForSelector too. */
const eventClick: BlockExecutor = async (data, ctx) =>
  runRaw(withWait({ action: 'click', target: targetFrom(data) }, data), ctx)
const hoverElement: BlockExecutor = async (data, ctx) =>
  runRaw(withWait({ action: 'hover', target: targetFrom(data) }, data), ctx)

/**
 * Block-executor registry, keyed by block id. The engine resolves the block id
 * from `WorkflowNode.data.blockId` (falling back to the legacy `label` field)
 * and dispatches through this map.
 */
export const EXECUTORS: Record<string, BlockExecutor> = {
  // browser
  'click': click,
  'fill': fill,
  'select-option': selectOption,
  'scroll': scroll,
  'press-key': pressKey,
  'wait-for': waitFor,
  'take-screenshot': takeScreenshot,
  'get-text': getText,
  'hover': hover,
  'set-checkbox': setCheckbox,
  'get-form': getForm,
  'set-radio': selectRadio,
  // navigation
  'open-url': openUrl,
  'new-tab': newTabExec,
  'switch-tab': switchTabExec,
  'close-tab': closeTabExec,
  'reload-tab': reloadTabExec,
  // data
  'set-variable': setVariable,
  'get-variable': getVariable,
  'insert-data': insertData,
  'export-data': exportData,
  'increase-variable': increaseVariable,
  'slice-variable': sliceVariable,
  'regex-variable': regexVariable,
  'delete-data': deleteDataExec,
  'sort-data': sortDataExec,
  'data-mapping': dataMapping,
  'log-data': logData,
  'workflow-state': workflowState,
  // control-flow
  'condition': condition,
  'loop-data': placeholder('loop-data'),
  'repeat-task': placeholder('repeat-task'),
  'while-loop': placeholder('while-loop'),
  'loop-elements': placeholder('loop-elements'),
  'delay': delay,
  'breakpoint': breakpoint,
  // browser actions (phase 2)
  'cookie': cookieBlock,
  'clipboard': clipboardBlock,
  'element-exists': elementExistsExec,
  'link': linkBlock,
  'attribute-value': attributeValueExec,
  'go-back': goBackExec,
  'forward-page': forwardPage,
  'tab-url': tabUrlExec,
  'active-tab': activeTabExec,
  'new-window': newWindowExec,
  'create-element': createElementExec,
  'upload-file': uploadFileExec,
  'handle-dialog': handleDialogExec,
  // integration
  'webhook': webhook,
  'notification': notification,
  'javascript-code': javascriptCode,
  'ai-prompt': aiPrompt,
  'ai-agent': aiAgent,
  'execute-workflow': placeholder('execute-workflow'),
  'parameter-prompt': parameterPrompt,
  'switch-to': switchToExec,
  'trigger-event': triggerEventExec,
  'browser-event': browserEvent,
  'handle-download': handleDownload,
  'save-assets': saveAssetsExec,
  'proxy': proxyExec,
  'google-sheets': googleSheets,
  'google-drive': googleDrive,
  'wait-connections': waitConnections,
  'note': note,
  'blocks-group': blocksGroup,
  // Automa-catalog ids produced by the editor / recorder.
  'trigger': noop,
  'event-click': eventClick,
  'hover-element': hoverElement,
  'element-scroll': elementScroll,
  'forms': formsBlock,
  'conditions': conditionsBlock,
  'loop-breakpoint': noop,
  // trigger
  'visit-web': noop,
  'schedule': noop,
  'manual': noop,
  'context-menu': noop,
  'on-startup': noop,
  'keyboard-shortcut': noop,
  'date': noop,
  'specific-day': noop,
  'element-change': noop,
}