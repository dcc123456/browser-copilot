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
  newWindow as driverNewWindow,
  switchTab as driverSwitchTab,
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
 * Run one op on the active tab and report the outcome. A thrown error is
 * emitted (not swallowed) and the engine continues on the default edge.
 */
async function runRaw(op: Op, ctx: WorkflowExecCtx): Promise<string | null> {
  assertActive(ctx)
  try {
    const result = await execOnActiveTab(op, ctx.signal)
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
        await execOnActiveTab(safe, ctx.signal)
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
      const result = await execOnActiveTab(op, ctx.signal)
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
  const tab = await activeTab()
  if (!tab || typeof tab.id !== 'number') {
    ctx.emit('error', '没有活动标签页')
    return null
  }
  await chrome.tabs.update(tab.id, { url })
  ctx.emit('result', `已打开 ${url}`)
  return null
}

const newTabExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const url = data['url'] ? String(data['url']) : undefined
  try {
    const tab = await driverNewTab(url)
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
  let ok = false
  try {
    const test = new Function('vars', 'refData', `return (${code})`)
    ok = Boolean(test(ctx.variables, ctx.refData))
  } catch {
    ctx.emit('error', '条件表达式错误')
    ok = false
  }
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
  try {
    const fn = new Function('vars', 'refData', 'data', `return (()=>{${code}})()`)
    const result = fn(ctx.variables, ctx.refData, data)
    ctx.variables['lastResult'] = result
    ctx.emit('result', String(result ?? ''))
  } catch (error) {
    ctx.emit('error', message(error))
  }
  return null
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
    )
    const info = result.data as { href?: string; target?: string } | undefined
    const href = info?.href ?? result.note ?? ''
    if (newTab && info?.target === '_self') {
      if (href) await driverNewTab(href)
      ctx.emit('result', `已在新标签页打开 ${href}`)
    } else {
      await execOnActiveTab({ action: 'click', target: cssTarget(selector) }, ctx.signal)
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
    const result = await execOnActiveTab(opData, ctx.signal)
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
    await execOnActiveTab(opData, ctx.signal)
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
  let mapped: unknown
  try {
    const fn = new Function('item', 'index', 'vars', `return (${expression})`)
    mapped = rows.map((item, index) => fn(item, index, ctx.variables))
  } catch (error) {
    ctx.emit('error', `data-mapping: ${message(error)}`)
    return null
  }
  ctx.variables[String(data['output'] ?? 'mappedData')] = mapped
  ctx.variables['lastMappedData'] = mapped
  ctx.emit('result', `已映射 ${rows.length} 行`)
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
    const result = await execOnActiveTab(op, ctx.signal)
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

/**
 * Block-executor registry, keyed by block id (the same ids defined in
 * `lib/workflow/registry.ts`). The engine resolves the block id from
 * `WorkflowNode.data.blockId` (falling back to the legacy `label` field) and
 * dispatches through this map, then passes the node's `data.values` bag as
 * the executor's `data` argument.
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