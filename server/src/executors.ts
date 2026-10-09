/**
 * Server-side workflow block executors — the Playwright-class implementations.
 *
 * A deliberate port of the extension's `background/workflow-engine/executors.ts`:
 * browser blocks drive pages through the shared in-page kernel (via the
 * server driver), data / control-flow blocks run locally with the same
 * semantics, and blocks that fundamentally belong to the extension (AI
 * takeover of side-panel prompts, chrome-only surfaces) degrade with clear,
 * explicit messages instead of failing silently.
 *
 * The engine contract is unchanged: each executor receives the node's params
 * plus the execution context and returns the next node id (or null). The map
 * is built per run via {@link createExecutors} so executors can close over the
 * run's driver session, artifacts directory and LLM provider.
 *
 * @module server/executors
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BlockExecutor, WorkflowExecCtx } from '../../src/background/workflow-engine/executors'
import { LoopBreakpointError } from '../../src/background/workflow-engine/loop-breakpoint'
import { sanitizeModelAnswer } from '../../src/lib/model-output'
import { streamCompletion, type WireMessage } from '../../src/lib/llm'
import { preprocessImage } from '../../src/lib/vision'
import { interpolate } from '../../src/lib/workflow/interpolate'
import { conditionGroupsMatch } from '../../src/lib/workflow/condition-tree'
import {
  applyAssignVariable,
  compareDataItems,
  cutBetweenMarkers,
  readRecordList,
  selectOptionFields,
  pickTabIndex,
  scrollSpecFrom,
  webhookContentTypeOf,
  webhookRecord,
} from '../../src/lib/workflow/block-output'
import { normalizeWorkflowFiles } from '../../src/lib/workflow/file-artifact'
import {
  coerceInputValue,
  missingRequiredInputs,
  workflowParametersOf,
} from '../../src/lib/workflow/workflow-inputs'
import type { Op, ScrollSpec, Target, TargetSpec } from '../../src/lib/ops'
import type { RunnerConfig } from './config'
import type { RunDriver } from './driver'
import { TAB_APPEAR_TIMEOUT_MS } from './driver'
import { runAgentTurnForBlock } from './agent/agent-loop'

// --- Small shared helpers (ported verbatim) -----------------------------------

/** Read the element selector off a block's data (Automa + legacy shapes). */
function sel(data: Record<string, unknown>): string {
  return (
    (typeof data['selector'] === 'string' && data['selector']) ||
    (typeof data['cssSelector'] === 'string' && data['cssSelector']) ||
    ''
  )
}

function cssTarget(selector: string): Target {
  return { primary: { how: 'css', value: selector }, fallbacks: [] }
}

/** The conversation's rich locator stored on generated nodes (see extension). */
function richTargetOf(data: Record<string, unknown>): Target | undefined {
  const raw = data['target']
  if (!raw || typeof raw !== 'object') return undefined
  const target = raw as Partial<Target> & Record<string, unknown>
  const primary = target.primary as TargetSpec | undefined
  if (!primary || typeof primary !== 'object') return undefined
  if (typeof primary.how !== 'string' || !primary.how) return undefined
  if (typeof primary.value !== 'string') return undefined
  return {
    primary,
    fallbacks: Array.isArray(target.fallbacks) ? (target.fallbacks as TargetSpec[]) : [],
    ...(typeof target.frameHint === 'string' && target.frameHint
      ? { frameHint: target.frameHint }
      : {}),
    ...(typeof target.label === 'string' && target.label ? { label: target.label } : {}),
  }
}

/** Build a `Target` from a block's data (selector primary, rich fallbacks). */
function targetFrom(data: Record<string, unknown>): Target {
  const selector = sel(data)
  const rich = richTargetOf(data)
  if (data['findBy'] === 'xpath') {
    const fallbacks = rich ? [rich.primary, ...rich.fallbacks] : []
    return { primary: { how: 'css', value: `xpath:${selector}` }, fallbacks }
  }
  if (!selector) {
    if (rich) return rich
    return cssTarget('')
  }
  const base = cssTarget(selector)
  if (!rich) return base
  const fallbacks = [rich.primary, ...rich.fallbacks].filter(
    (spec) => !(spec.how === 'css' && spec.value === selector),
  )
  return { ...base, fallbacks }
}

function assertActive(ctx: WorkflowExecCtx): void {
  if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Short human preview of a value for log lines. */
function logPreview(value: string, max = 120): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/** Apply Automa's waitForSelector to an op (the kernel polls in-page). */
function withWait<T extends Op>(op: T, data: Record<string, unknown>): T {
  if (data['waitForSelector'] === true) {
    op.waitFor = Number(data['waitSelectorTimeout'] ?? 5000)
  }
  return op
}

/** Abort-aware sleep (ported). */
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

// --- Per-run dependency bundle -------------------------------------------------

export interface ExecutorDeps {
  driver: RunDriver
  config: RunnerConfig
  /** Absolute directory for this run's files (exports, downloads, screenshots). */
  artifactsDir: string
  signal: AbortSignal
  /** Resolved LLM provider (config.llm); null when not configured. */
  provider: {
    apiKey: string
    baseUrl: string
    model: string
    headers?: Record<string, string>
  } | null
}

// --- Local (off-page) workflow JS fallback (ported verbatim) --------------------

async function evalLocalWorkflowJs(
  code: string,
  variables: Record<string, unknown>,
  timeout: number,
): Promise<
  { ok: true; result?: unknown; variables?: Record<string, unknown> } | { ok: false; error: string }
> {
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
        /* local eval runs to completion */
      },
    }
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
      Promise.resolve(
        fn(
          helpers.automaNextBlock,
          helpers.automaSetVariable,
          helpers.automaRefData,
          helpers.automaResetTimeout,
          working,
        ),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`JavaScript 代码超时（${timeout}ms）`)),
          Math.max(0, timeout) || 20000,
        ),
      ),
    ])
    return { ok: true, result: nextCalled ? nextData : awaited, variables: working }
  } catch (error) {
    return { ok: false, error: clarifyWorkerJsError(error) }
  }
}

/**
 * Browser-only globals whose presence distinguishes "this code needs a page" from
 * a plain typo. If the local (Node) fallback meets a ReferenceError on one of
 * these, the page bridge failed to run first and the code cannot work here.
 */
const BROWSER_ONLY_GLOBALS = new Set([
  'document',
  'window',
  'location',
  'navigator',
  'screen',
  'history',
  'localStorage',
  'sessionStorage',
  'alert',
  'confirm',
  'prompt',
  'getSelection',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'Node',
  'Document',
])

/** Turns a bare `xxx is not defined` into an actionable hint about the page bridge. */
function clarifyWorkerJsError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const m = /^(?:ReferenceError:\s*)?([A-Za-z_$][\w$]*)\s+is not defined/.exec(raw)
  const name = m?.[1]
  if (name && BROWSER_ONLY_GLOBALS.has(name)) {
    return `${raw}。这段代码引用了只在网页中存在的全局「${name}」，无法在服务端运行；当前未能注入页面（未找到可操作的 http(s) 页面），因此回退到本地求值失败。请先在普通 http(s) 网页上运行，或把该步骤改成浏览器操作块。`
  }
  return raw
}

/** Local OCR via Tesseract.js (Node): the offscreen-document equivalent. */
async function ocrImageNode(
  dataUrl: string,
  lang: string,
): Promise<{ ok: true; text: string; confidence: number } | { ok: false; error: string }> {
  try {
    const { createWorker } = await import('tesseract.js')
    const worker = await createWorker(lang)
    try {
      const { data } = await worker.recognize(dataUrl)
      return { ok: true, text: data.text ?? '', confidence: data.confidence ?? 0 }
    } finally {
      await worker.terminate()
    }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
}

/** Normalizes an image reference into a data URL (ported from the extension). */
async function imageInputToDataUrl(raw: string, signal: AbortSignal): Promise<string | null> {
  const value = raw.trim()
  if (!value) return null
  if (/^data:image\//i.test(value)) return value
  if (/^https?:\/\//i.test(value)) {
    try {
      const response = await fetch(value, { signal, credentials: 'include' })
      if (!response.ok) return null
      const contentType = response.headers.get('content-type') ?? ''
      const mime = contentType.startsWith('image/') ? contentType : 'image/png'
      const bytes = new Uint8Array(await response.arrayBuffer())
      return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
      return null
    }
  }
  const compact = value.replace(/\s+/g, '')
  if (compact.length >= 32 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    return `data:image/png;base64,${compact}`
  }
  return null
}

/** Writes a file into the run's artifacts directory (returns the absolute path). */
function writeArtifact(artifactsDir: string, filename: string, content: string): string {
  mkdirSync(artifactsDir, { recursive: true })
  const safe = filename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
  const path = join(artifactsDir, safe)
  writeFileSync(path, content, 'utf8')
  return path
}

/** Decodes a `data:` URL into a Playwright file payload (for upload-file). */
function dataUrlToFilePayload(
  dataUrl: string,
): { name: string; mimeType: string; buffer: Buffer } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl.trim())
  if (!match) return null
  const mimeType = match[1] || 'application/octet-stream'
  const isBase64 = !!match[2]
  const body = match[3] ?? ''
  try {
    const buffer = isBase64
      ? Buffer.from(body, 'base64')
      : Buffer.from(decodeURIComponent(body), 'utf8')
    return { name: 'upload', mimeType, buffer }
  } catch {
    return null
  }
}

// --- The registry factory --------------------------------------------------------

/**
 * Builds the block-executor map for ONE run. `deps` carry the run's driver
 * session, artifacts directory and resolved LLM provider.
 */
export function createExecutors(deps: ExecutorDeps): Record<string, BlockExecutor> {
  const { driver, config, artifactsDir, signal, provider } = deps

  /** Run one op and raise failures so the engine's onError machinery applies. */
  const runRaw = async (op: Op, ctx: WorkflowExecCtx): Promise<string | null> => {
    assertActive(ctx)
    const result = await driver.execOp(op, ctx.tabId)
    if (result && result.ok === false) {
      throw new Error(result.error || `${op.action} 失败`)
    }
    ctx.emit('result', result?.note ?? 'ok')
    return null
  }

  /** Evaluate user JS in the page; failures are reported, not thrown. */
  const evalInPage = async (
    code: string,
    args: Record<string, unknown>,
    ctx: WorkflowExecCtx,
  ): Promise<{ ok: boolean; value?: unknown }> => {
    try {
      const result = await driver.execJs(code, args, ctx.tabId)
      if (result.ok) return { ok: true, value: result.data }
      ctx.emit('error', `JS 执行失败: ${result.error ?? '未知错误'}`)
      return { ok: false }
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
      ctx.emit('error', `JS 执行失败: ${message(error)}`)
      return { ok: false }
    }
  }

  // --- Browser executors -------------------------------------------------------

  // `withWait` parity with the extension's executors: `applyDefaultWaits`
  // force-sets `waitForSelector` on these blocks, and a flag the executor
  // ignores is a wait that never happens — the runner would then fail steps
  // the extension replays fine.
  const click: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    return runRaw(withWait({ action: 'click', target: targetFrom(data) }, data), ctx)
  }

  const fill: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const value = String(data['value'] ?? '')
    return runRaw(withWait({ action: 'fill', target: targetFrom(data), value }, data), ctx)
  }

  const selectOption: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const value = String(data['value'] ?? '')
    return runRaw(withWait({ action: 'select_option', target: targetFrom(data), value }, data), ctx)
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

    if (mode === 'incremental') {
      const step = Math.max(1, Number(data['step'] ?? 120))
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x), Math.abs(y)) / step))
      for (let i = 0; i < steps; i += 1) {
        assertActive(ctx)
        const safe = {
          ...op,
          scroll: { mode: 'by' as const, x: x / steps, y: y / steps, smooth: true },
        }
        try {
          await driver.execOp(safe, ctx.tabId)
        } catch (error) {
          ctx.emit('error', message(error))
          break
        }
      }
      ctx.emit('result', `增量滚动完成`)
      return null
    }

    return runRaw(withWait(op, data), ctx)
  }

  const pressKey: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const key = String(data['keys'] ?? data['keysToPress'] ?? data['key'] ?? '')
    // The form's target field decides WHICH control receives the key; without it
    // the event went to whatever the page had focused (nothing, on a fresh tab).
    const selector = sel(data)
    ctx.emit('status', `按下按键: ${key}${selector ? ` → ${selector}` : ''}`)
    if (!selector) return runRaw({ action: 'press_key', value: key }, ctx)
    return runRaw(
      withWait({ action: 'press_key', value: key, target: targetFrom(data) }, data),
      ctx,
    )
  }

  const hover: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    return runRaw(withWait({ action: 'hover', target: targetFrom(data) }, data), ctx)
  }

  const setCheckbox: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const checked = (data['checked'] as boolean | undefined) ?? true
    return runRaw(
      withWait({ action: 'set_checkbox', target: targetFrom(data), value: checked }, data),
      ctx,
    )
  }

  const waitFor: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const result = await driver.execOp({ action: 'wait_for', target: targetFrom(data) }, ctx.tabId)
    if (result?.found) ctx.emit('result', '元素已出现')
    else throw new Error('等待超时，元素未出现')
    return null
  }

  const takeScreenshot: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const type = (data['type'] as string | undefined) ?? 'page'
    const selector = sel(data)
    const variable = String(data['variableName'] ?? 'lastScreenshot')

    try {
      const dataUrl = await driver.screenshot(
        type === 'fullpage' ? 'fullpage' : type === 'element' ? 'element' : 'page',
        type === 'element' ? selector : undefined,
      )
      ctx.variables[variable] = dataUrl
      ctx.emit('result', `已截图 (${type})`)

      // The edit form's "save to computer" / column fields were pure decoration
      // here: the capture only ever landed in a variable, so checking the box
      // wrote nothing — same contract the extension engine now honours.
      if (data['saveToComputer'] === true) {
        const rawName = interpolate(
          String(data['fileName'] ?? ''),
          ctx.variables,
          ctx.refData,
        ).trim()
        const ext = dataUrl.startsWith('data:image/jpeg') ? 'jpeg' : 'png'
        const base = rawName || 'screenshot'
        const filename = /\.[a-z0-9]+$/i.test(base) ? base : `${base}.${ext}`
        mkdirSync(artifactsDir, { recursive: true })
        const path = join(artifactsDir, filename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_'))
        writeFileSync(path, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
        ctx.variables['lastScreenshotPath'] = filename
        ctx.emit('info', `已写出文件: ${path}`)
      }
      const column = String(data['dataColumn'] ?? '').trim()
      if (data['saveToColumn'] === true && column) {
        ctx.emit(
          'info',
          `已写入数据表列「${column}」${collectReadColumn(ctx, column, [dataUrl])} 行`,
        )
      }
    } catch (error) {
      ctx.emit('error', `截图失败: ${message(error)}`)
    }
    return null
  }

  /**
   * Reads publish through the same contract the extension engine uses: the
   * declared `variableName` (plus the legacy fallback name), and the data table
   * column when `saveData` is on — otherwise `export-data` writes an empty file.
   */
  function collectReadColumn(
    ctx: WorkflowExecCtx,
    column: string,
    values: readonly string[],
  ): number {
    if (!Array.isArray(ctx.variables['dataTable'])) ctx.variables['dataTable'] = []
    const table = ctx.variables['dataTable'] as Record<string, unknown>[]
    values.forEach((value, index) => {
      while (table.length <= index) table.push({})
      table[index][column] = value
    })
    return values.length
  }

  function requireReadMatch(what: string, values: readonly string[]): void {
    if (values.some((value) => String(value ?? '').trim() !== '')) return
    throw new Error(
      `${what} 没有读到任何内容。请依次排查：① 选择器是否写对；② 元素是否由脚本稍后渲染（加 wait-connections 或 delay）；③ 读的是否是本轮标签页；④ 元素是否在 iframe 内（只读主框架）。若要「有则读、没有就跳过」，请改用 element-exists 分支。`,
    )
  }

  function publishRead(
    ctx: WorkflowExecCtx,
    data: Record<string, unknown>,
    values: readonly string[],
    fallbackVariable: string,
  ): void {
    // "Text prefix" / "Text suffix" are markers, not decoration (see
    // `cutBetweenMarkers`); nothing applied them, so a read configured to strip
    // its label published the whole element text.
    const prefix = String(data['prefixText'] ?? '')
    const suffix = String(data['suffixText'] ?? '')
    const kept =
      prefix === '' && suffix === ''
        ? values
        : values.map((text) => cutBetweenMarkers(text, prefix, suffix))
    const value: unknown = data['multiple'] === true ? kept : (kept[0] ?? '')
    const variable = String(data['variableName'] ?? '').trim() || fallbackVariable
    ctx.variables[variable] = value
    if (variable !== fallbackVariable) ctx.variables[fallbackVariable] = value
    if (data['saveData'] === true) {
      const column = String(data['dataColumn'] ?? '').trim()
      if (!column) {
        ctx.emit('info', '未指定数据列名（dataColumn），本次读取未写入数据表')
      } else {
        ctx.emit('info', `已写入数据表列「${column}」${collectReadColumn(ctx, column, kept)} 行`)
      }
    }
    ctx.emit('result', Array.isArray(value) ? value.join('\n') : String(value))
  }

  /** The same in-page read the extension injects (no closure over helpers). */
  function readTextsJs(
    selector: string,
    multiple: boolean,
    useTextContent: boolean,
    includeTags: boolean,
  ): string {
    return `(() => {
      const selector = ${JSON.stringify(selector)}
      const nodes = selector ? Array.from(document.querySelectorAll(selector)) : []
      if (nodes.length === 0) return []
      const picked = ${multiple} ? nodes : nodes.slice(0, 1)
      return picked.map((node) => {
        const el = node
        if (${includeTags}) return el.innerHTML ?? ''
        if (${useTextContent}) return el.textContent ?? ''
        return el.innerText || el.textContent || ''
      })
    })()`
  }

  /** Run an in-page read, polling while it comes back empty (a replay races the page). */
  async function readValues(code: string, ctx: WorkflowExecCtx, waitMs: number): Promise<string[]> {
    const deadline = Date.now() + Math.max(0, waitMs)
    for (;;) {
      const result = await driver.execJs(code, {}, ctx.tabId)
      const raw = result.ok ? result.data : undefined
      const values = Array.isArray(raw) ? raw.map((v) => String(v)) : []
      if (values.length > 0 || Date.now() >= deadline) return values
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  function readWaitMs(data: Record<string, unknown>): number {
    if (data['waitForSelector'] !== true) return 0
    return Math.max(0, Number(data['waitSelectorTimeout'] ?? 5000))
  }

  const getText: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const selector = sel(data)
    if (!selector) {
      throw new Error('get-text: 缺少 selector，不知道要读哪个元素。')
    }
    const values = await readValues(
      readTextsJs(
        selector,
        data['multiple'] === true,
        data['useTextContent'] === true,
        data['includeTags'] === true,
      ),
      ctx,
      readWaitMs(data),
    )
    requireReadMatch(`get-text(selector: "${selector}")`, values)
    publishRead(ctx, data, values, 'lastText')
    return null
  }

  const readPage: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const source = String(data['source'] ?? 'text')
    const selector = String(data['selector'] ?? '').trim()
    const requested = Number(data['maxChars'])
    const maxChars = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 20000
    let values: string[]
    if (source === 'selection') {
      const result = await driver.execJs('window.getSelection().toString()', {}, ctx.tabId)
      values = [String(result.ok ? result.data : '')]
      if (!values[0].trim()) {
        ctx.emit('error', 'read-page: 当前没有选中任何文本（source: selection）——读取结果为空')
      }
    } else if (source === 'html') {
      const code = `(() => {
        const selector = ${JSON.stringify(selector)}
        const el = selector ? document.querySelector(selector) : document.documentElement
        return el ? el.outerHTML : ''
      })()`
      const html = await driver.execJs(code, {}, ctx.tabId)
      values = [String(html.ok ? html.data : '').slice(0, maxChars)]
      if (selector && !values[0]) {
        throw new Error(`read-page: 选择器 ${selector} 没有匹配到元素，无法读取 HTML`)
      }
    } else {
      const read = await readValues(
        readTextsJs(selector || 'body', true, false, false),
        ctx,
        readWaitMs(data),
      )
      values = [read.join('\n').slice(0, maxChars)]
    }
    requireReadMatch(`read-page(source: "${source}")`, values)
    publishRead(ctx, { ...data, multiple: false }, values, 'lastPageText')
    return null
  }

  const ocrBlock: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const source = String(data['source'] ?? (sel(data) ? 'element' : 'page'))

    let image = ''
    if (source === 'variable') {
      const name = String(data['imageVariable'] ?? 'lastScreenshot')
      const raw = ctx.variables[name]
      const value = typeof raw === 'string' ? raw.trim() : ''
      if (!value) {
        ctx.emit('error', `ocr: 变量 ${name} 为空或不是字符串`)
        return null
      }
      const normalized = await imageInputToDataUrl(value, ctx.signal)
      if (!normalized) {
        ctx.emit(
          'error',
          `ocr: 变量 ${name} 不是可识别的图片（支持 base64、data URL 或 http(s) 图片链接）`,
        )
        return null
      }
      image = normalized
    } else if (source === 'element') {
      const selector = sel(data)
      if (!selector) {
        ctx.emit('error', 'ocr: 页面 img 元素识别需要 CSS 选择器')
        return null
      }
      try {
        image = await driver.screenshot('element', selector)
      } catch (error) {
        ctx.emit('error', `ocr: ${message(error)}`)
        return null
      }
    } else {
      try {
        image = await driver.screenshot('page')
      } catch (error) {
        ctx.emit('error', `ocr: ${message(error)}`)
        return null
      }
    }

    // Preprocessing is a no-op without OffscreenCanvas (plain Node) — it
    // returns the input unchanged, matching the extension's guard.
    let processed = image
    if (data['preprocess'] !== false) {
      try {
        processed = await preprocessImage(image)
      } catch {
        processed = image
      }
    }

    const langParam = interpolate(String(data['lang'] ?? ''), ctx.variables, ctx.refData).trim()
    const lang = langParam || 'eng'

    const ocr = await ocrImageNode(processed, lang)
    if (!ocr.ok || !ocr.text.trim()) {
      if (!ocr.ok) throw new Error(`ocr: ${ocr.error}`)
      throw new Error(`ocr: 未识别到文字 (${lang}) — 图像 ${image.length} 字符`)
    }
    const text = ocr.text.trim()
    const variable = String(data['variableName'] ?? '').trim() || 'lastOcrText'
    ctx.variables[variable] = text
    ctx.emit('info', `[识别输出] ${variable} = ${logPreview(text, 200) || '(空)'}`)
    ctx.emit('result', `${text.slice(0, 80)} (置信度 ${Math.round(ocr.confidence)})`)
    return null
  }

  // --- Navigation executors ------------------------------------------------------
  //
  // All three tab blocks rethrow, like the extension's (`executors.ts`
  // `newTabExec`/`switchTabExec`/`closeTabExec`). Reporting a tab that never
  // opened as green is the worst failure mode a replay can have: every later
  // step then runs against the page the workflow had already left.

  const newTabExec: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const url = data['url'] ? String(data['url']) : undefined
    const ua =
      data['customUserAgent'] === true
        ? interpolate(String(data['userAgent'] ?? ''), ctx.variables, ctx.refData).trim()
        : ''
    const tab = await driver.newTab(url, ua === '' ? undefined : ua)
    ctx.setTab?.(tab.id)
    if (url && data['waitTabLoaded'] !== false) {
      await driver.waitForLoaded(tab.id)
    }
    ctx.emit('result', `已打开 ${url ?? '新标签页'} (tab #${tab.id})`)
    return null
  }

  const switchTabExec: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    // Same lookup as the extension (`pickTabIndex`). This read only `index` — a
    // key the editor never writes — so every authored node jumped to tab 0 and
    // still reported 已切换.
    const listed0 = driver.listTabs()
    if (listed0.length === 0) throw new Error('switch-tab: 没有可切换的标签页')
    const pattern = interpolate(String(data['matchPattern'] ?? ''), ctx.variables, ctx.refData)
    const title = interpolate(String(data['tabTitle'] ?? ''), ctx.variables, ctx.refData)
    const current = ctx.tabId
    // Runner-only race, the same one `driver.switchTab` waits out: a page a click
    // just spawned is reported by Playwright's `page` event AFTER the click
    // resolves, so a by-URL/by-title lookup run immediately can miss a tab the
    // workflow really opened.
    const deadline = Date.now() + TAB_APPEAR_TIMEOUT_MS
    let tabs: { id: number; url: string; title: string }[] = []
    let picked = { index: -1, byIndex: false }
    for (;;) {
      // `listTabs` reports an empty title (Playwright reads it per page, async).
      tabs = await Promise.all(
        driver.listTabs().map(async (tab) => ({
          ...tab,
          title:
            (await driver
              .pageById(tab.id)
              ?.title()
              .catch(() => tab.title)) ?? tab.title,
        })),
      )
      picked = pickTabIndex(data, tabs, current, { matchPattern: pattern, tabTitle: title })
      if (picked.index >= 0 || picked.byIndex || Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const { index, byIndex } = picked
    if (byIndex && (index < 0 || index >= tabs.length)) {
      throw new Error(
        `switch-tab: 标签页索引 ${index} 超出范围（本次运行共 ${tabs.length} 个），无法切换`,
      )
    }
    if (index < 0) {
      const createUrl = interpolate(String(data['url'] ?? ''), ctx.variables, ctx.refData)
      if (data['createIfNoMatch'] === true && createUrl) {
        const tab = await driver.newTab(createUrl)
        ctx.setTab?.(tab.id)
        await driver.waitForLoaded(tab.id)
        ctx.emit('result', `没有匹配的标签页，已新建 #${tab.id}`)
        return null
      }
      throw new Error(
        `switch-tab: 没有匹配的标签页（findTabBy=${String(data['findTabBy'] ?? 'match-patterns')}）`,
      )
    }
    const tab = await driver.switchTab(index)
    ctx.setTab?.(tab.id)
    ctx.emit('result', `已切换到标签页 #${tab.id} (${tab.url})`)
    return null
  }

  const closeTabExec: BlockExecutor = async (_data, ctx) => {
    assertActive(ctx)
    await driver.closeActiveTab()
    // The driver hands activation to the last surviving page; the run's tab
    // pointer has to follow it, or every later step drives a closed page.
    const survivor = driver.activeTabId()
    if (survivor !== undefined) ctx.setTab?.(survivor)
    ctx.emit('result', '已关闭当前标签页')
    return null
  }

  const reloadTabExec: BlockExecutor = async (_data, ctx) => {
    assertActive(ctx)
    await driver.reloadTab()
    ctx.emit('result', '已刷新当前标签页')
    return null
  }

  const openUrl: BlockExecutor = async (data, ctx) => {
    // The legacy MVP block: navigate the CURRENT page.
    assertActive(ctx)
    const url = String(data['url'] ?? '')
    const target = driver.pageById(ctx.tabId ?? -1) ?? driver.activePage()
    if (!target) {
      ctx.emit('error', '没有可操作的网页标签页')
      return null
    }
    await target.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
    ctx.emit('result', `已打开 ${url}`)
    return null
  }

  // --- Data / control-flow / integration executors ---------------------------------

  const setVariable: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const name = String(data['variableName'] ?? '')
    const value = interpolate(String(data['value'] ?? ''), ctx.variables, ctx.refData)
    ctx.variables[name] = value
    ctx.emit('result', `已设置变量 ${name} = ${logPreview(value) || '(空)'}`)
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
    // Mirror of the extension executor: `dataList` items are either editor
    // instructions (`{ type: 'table' | 'variable', name, value }`) or the
    // records a generated graph writes directly. Pushing the instructions as
    // rows silently filled the table with `{ type, name, value }` objects.
    const items = readRecordList(data['dataList'] ?? data['data'])
    if (!Array.isArray(ctx.variables['dataTable'])) ctx.variables['dataTable'] = []
    const table = ctx.variables['dataTable'] as Record<string, unknown>[]
    let rows = 0
    for (const item of items) {
      const record = (item ?? {}) as Record<string, unknown>
      const kind = String(record['type'] ?? '')
      const name = String(record['name'] ?? '').trim()
      if (kind === 'table' || kind === 'variable') {
        if (name === '') continue
        const value = interpolate(String(record['value'] ?? ''), ctx.variables, ctx.refData)
        if (kind === 'variable') {
          ctx.variables[name] =
            record['action'] === 'append' ? `${ctx.variables[name] ?? ''}${value}` : value
        } else {
          if (table.length === 0) table.push({})
          for (const row of table) row[name] = value
        }
        rows += 1
        continue
      }
      table.push(item as Record<string, unknown>)
      rows += 1
    }
    ctx.emit('result', `已插入 ${rows} 项`)
    return null
  }

  const exportData: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    // `type` / `name` are the keys the catalog declares and the edit form writes;
    // `format` / `filename` are this executor's older names, kept as fallbacks.
    const format = String(data['type'] ?? data['format'] ?? 'csv')
    const delimiter = String(data['csvDelimiter'] ?? '') || ','
    const mode = String(data['dataToExport'] ?? 'data-columns')
    if (mode === 'google-sheets') {
      throw new Error('export-data: Google Sheets 导出需要 OAuth 凭据，尚未配置')
    }
    let text = ''
    if (mode === 'variable') {
      const variable = String(data['variableName'] ?? '').trim()
      if (!variable) {
        throw new Error('export-data: 导出目标是「变量」但没有填 variableName，无法导出')
      }
      const value = ctx.variables[variable]
      text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
    } else {
      const table = Array.isArray(ctx.variables['dataTable'])
        ? (ctx.variables['dataTable'] as Record<string, unknown>[])
        : Array.isArray(ctx.refData)
          ? (ctx.refData as Record<string, unknown>[])
          : []
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
        text = rows.map((row) => row.join(delimiter)).join('\n')
      }
    }
    ctx.variables['lastExport'] = text
    // Server convenience on top of the extension contract: the export also
    // lands in the run's artifacts directory, so the file is retrievable.
    if (text) {
      const ext = format === 'json' ? 'json' : 'csv'
      const rawName = interpolate(
        String(data['name'] ?? data['filename'] ?? ''),
        ctx.variables,
        ctx.refData,
      ).trim()
      const fileName = rawName.includes('.')
        ? rawName
        : `${rawName || `export-${Date.now()}`}.${ext}`
      const body = format === 'csv' && data['addBOMHeader'] === true ? `﻿${text}` : text
      const path = writeArtifact(artifactsDir, fileName, body)
      ctx.emit('info', `已写出文件: ${path}`)
    }
    ctx.emit('result', text.slice(0, 80))
    return null
  }

  const condition: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const code = String(data['code'] ?? 'true')
    const evaluated = await evalInPage(
      `return (${code})`,
      { vars: ctx.variables, refData: ctx.refData },
      ctx,
    )
    const ok = evaluated.ok ? Boolean(evaluated.value) : false
    return ok
      ? (ctx.outputs?.['true'] ?? ctx.defaultNext ?? null)
      : (ctx.outputs?.['false'] ?? ctx.defaultNext ?? null)
  }

  const delay: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const raw = data['time'] ?? data['ms']
    const ms = raw === undefined || raw === null || raw === '' ? 500 : Number(raw)
    await sleep(Number.isFinite(ms) ? ms : 500, ctx.signal)
    ctx.emit('status', `延时 ${ms}ms`)
    return null
  }

  const breakpoint: BlockExecutor = async (_data, ctx) => {
    assertActive(ctx)
    ctx.emit('info', '断点：服务端运行中跳过（不暂停）')
    return null
  }

  const webhook: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const url = interpolate(String(data['url'] ?? ''), ctx.variables, ctx.refData)
    const method = String(data['method'] ?? 'POST').toUpperCase()
    const timeout = Math.max(0, Number(data['timeout'] ?? 30000))
    // `variableName` is the catalog + edit-form key; `responseVariable` is the
    // legacy name. The extension accepts both; reading only the latter meant a
    // user- or model-chosen name never existed downstream.
    const responseVariable = String(
      data['variableName'] || data['responseVariable'] || 'lastHttpResponse',
    )
    // `responseType` decides how the body is decoded and `dataPath` narrows it —
    // both are edit-form fields the port used to ignore, so the stored record had
    // no `data` key and `{{resp.data.total}}` dangled there.
    const responseType = String(data['responseType'] ?? 'json')
    const dataPath = String(data['dataPath'] ?? '')

    let headers: Record<string, string> = { 'content-type': webhookContentTypeOf(data) }
    const headersRaw = interpolate(String(data['headers'] ?? ''), ctx.variables, ctx.refData)
    if (headersRaw.trim()) {
      try {
        const parsed = JSON.parse(headersRaw)
        if (parsed && typeof parsed === 'object')
          headers = { ...headers, ...parsed } as Record<string, string>
      } catch {
        ctx.emit('error', 'webhook: headers 不是合法 JSON，使用默认头')
      }
    }

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
        const record = await webhookRecord(response, responseType, dataPath)
        ctx.variables[responseVariable] = record
        ctx.emit('result', `${method} ${response.status} ${record.body.slice(0, 80)}`)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
      }
    } catch (error) {
      // A request that never landed must fail the step, like it does on the
      // extension: logging it and returning let a workflow continue as though
      // the webhook had been delivered.
      if ((error as Error)?.name === 'AbortError') throw new Error(`${method} 请求超时或已取消`)
      throw error
    }
    return null
  }

  const notification: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const title = interpolate(String(data['title'] ?? '通知'), ctx.variables, ctx.refData)
    const body = interpolate(String(data['message'] ?? ''), ctx.variables, ctx.refData)
    ctx.emit('info', `[通知] ${title}: ${body}`)
    ctx.emit('result', '已通知（服务端记录为日志）')
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
    let run: Awaited<ReturnType<typeof driver.execWorkflowJs>> | null = null
    let triedPage = false
    try {
      triedPage = true
      run = await driver.execWorkflowJs(code, ctx.variables, timeout, ctx.tabId)
    } catch {
      run = null
    }

    if (run && run.ok) {
      for (const line of run.data.logs ?? []) {
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
      for (const line of run.logs ?? []) {
        ctx.emit(line.level === 'error' || line.level === 'warn' ? 'error' : 'info', line.message)
      }
    }

    // Fallback: evaluate locally (valid in Node; pages with strict CSP land here).
    const local = await evalLocalWorkflowJs(code, ctx.variables, timeout)
    if (!local.ok) {
      ctx.emit('error', `javascript-code: ${run && !run.ok ? run.error : local.error}`)
      return null
    }
    for (const [k, v] of Object.entries(local.variables ?? {})) ctx.variables[k] = v
    ctx.variables['lastResult'] = local.result
    if (local.result !== undefined) {
      ctx.emit(
        'result',
        typeof local.result === 'string' ? local.result : safeStringify(local.result),
      )
    }
    return null
  }

  const aiPrompt: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const prompt = interpolate(String(data['prompt'] ?? ''), ctx.variables, ctx.refData)
    if (!provider || !provider.apiKey.trim()) {
      throw new Error('AI 块: 服务端未配置模型（BC_LLM_BASE_URL / BC_LLM_API_KEY / BC_LLM_MODEL）')
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
      const clean = sanitizeModelAnswer(result.content)
      ctx.variables['lastAIResponse'] = clean
      ctx.emit('result', clean)
    } catch (error) {
      ctx.variables['lastAIResponse'] = ''
      throw new Error(`AI 块: ${message(error)}`)
    }
    return null
  }

  const cookieBlock: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    // `type` is the edit form's name for this choice and `op` the tool schema's;
    // the extension accepts both, the port read only `op` — so an editor-built
    // "set cookie" node ran the GET branch and silently did nothing.
    const op = String(data['op'] ?? data['type'] ?? 'get')
    const name = interpolate(String(data['name'] ?? ''), ctx.variables, ctx.refData)
    const value = interpolate(String(data['value'] ?? ''), ctx.variables, ctx.refData)
    const url = interpolate(String(data['url'] ?? ''), ctx.variables, ctx.refData)
    const variable = String(data['variableName'] ?? 'lastCookie')
    try {
      if (op === 'getAll') {
        const cookies = await driver.cookieGetAll(url || undefined)
        ctx.variables[variable] = cookies
        ctx.emit('result', `已读取 ${cookies.length} 个 Cookie`)
      } else if (op === 'get') {
        const cookie = await driver.cookieGet(name, url || undefined)
        ctx.variables[variable] = cookie ?? ''
        ctx.emit('result', cookie !== null ? `已读取 ${name}` : `未找到 ${name}`)
      } else if (op === 'set') {
        if (!url) {
          ctx.emit('error', 'cookie: 写入需要 URL')
          return null
        }
        const expiry = Number(data['expirationDate'] ?? 0)
        await driver.cookieSet(name, value, url, expiry > 0 ? expiry : undefined)
        ctx.emit('result', `已写入 ${name}`)
      } else if (op === 'remove') {
        if (!url) {
          ctx.emit('error', 'cookie: 删除需要 URL')
          return null
        }
        await driver.cookieRemove(name, url)
        ctx.emit('result', `已删除 ${name}`)
      } else {
        ctx.emit('error', `cookie: 不支持的操作 ${op}`)
      }
    } catch (error) {
      ctx.emit('error', message(error))
    }
    return null
  }

  /** The page's current text selection — `copySelectedText`'s source. */
  async function pageSelectionText(ctx: WorkflowExecCtx): Promise<string> {
    const run = await driver.execWorkflowJs(
      'return String(window.getSelection ? window.getSelection().toString() : "")',
      ctx.variables,
      10_000,
      ctx.tabId,
    )
    if (!run.ok) throw new Error(run.error)
    return typeof run.data.result === 'string' ? run.data.result : ''
  }

  const clipboardBlock: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    // Same drift as `cookie`: the editor writes `type`, the tool schema `op`.
    const op = String(data['op'] ?? data['type'] ?? 'get')
    try {
      if (op === 'get') {
        // Mirror of the extension: `copySelectedText` (the form's "Copy selected
        // text" checkbox) reads the page selection, not the system clipboard.
        const text =
          data['copySelectedText'] === true
            ? await pageSelectionText(ctx)
            : await driver.clipboardGet()
        ctx.variables[String(data['variableName'] ?? 'lastClipboard')] = text
        ctx.emit('result', text.slice(0, 80))
      } else {
        // `dataToCopy` is the catalog's name for the text; `text` the schema's.
        const text = interpolate(
          String(data['text'] ?? data['dataToCopy'] ?? ''),
          ctx.variables,
          ctx.refData,
        )
        await driver.clipboardInsert(text)
        ctx.emit('result', '已写入剪贴板')
      }
    } catch (error) {
      ctx.emit('error', `剪贴板 ${op}: ${message(error)}`)
    }
    return null
  }

  const elementExistsExec: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const count = await driver.elementExists(sel(data), ctx.tabId)
    const exists = count > 0
    ctx.emit('result', exists ? `元素存在 (${count})` : '元素不存在')
    return exists
      ? (ctx.outputs?.['exists'] ?? ctx.defaultNext ?? null)
      : (ctx.outputs?.['notExists'] ?? ctx.defaultNext ?? null)
  }

  const linkBlock: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const selector = sel(data)
    // `newTab` is what the tool schema teaches, `openInNewTab` what the edit form
    // writes; reading only the former left the form's choice ignored.
    const newTab =
      (data['newTab'] as boolean | undefined) ??
      (data['openInNewTab'] as boolean | undefined) ??
      true
    try {
      const result = await driver.execOp(
        { action: 'click_link', target: cssTarget(selector) },
        ctx.tabId,
      )
      const info = result.data as { href?: string; target?: string } | undefined
      const href = info?.href ?? result.note ?? ''
      const waitLoaded = data['waitTabLoaded'] !== false
      if (newTab && info?.target === '_self') {
        if (href) {
          const tab = await driver.newTab(href)
          ctx.setTab?.(tab.id)
          if (waitLoaded) await driver.waitForLoaded(tab.id)
        }
        ctx.emit('result', `已在新标签页打开 ${href}`)
      } else {
        // A same-tab link is only "opened" once the page has left this URL: the
        // synthetic click returns while the navigation is still queued, so
        // `waitForLoaded` saw the PREVIOUS document's load state and reported
        // 已点击链接 too early — a following go-back then raced mid-navigation.
        const before = driver.currentUrl(ctx.tabId)
        const navigates = href !== '' && !href.startsWith('#') && !href.startsWith('javascript:')
        await runRaw(withWait({ action: 'click', target: cssTarget(selector) }, data), ctx)
        if (waitLoaded) {
          if (navigates) await driver.waitForUrlLeave(ctx.tabId, before)
          await driver.waitForLoaded(ctx.tabId)
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
    const op = String(data['op'] ?? data['action'] ?? 'get')
    const attribute = String(data['attribute'] ?? data['attributeName'] ?? '')
    const variable = String(data['variableName'] ?? 'lastAttribute')
    const opData: Op = {
      action: op === 'set' ? 'set_attribute' : 'get_attribute',
      target: targetFrom(data),
      attribute,
    }
    if (op === 'set')
      opData.value = interpolate(
        String(data['value'] ?? data['attributeValue'] ?? ''),
        ctx.variables,
        ctx.refData,
      )
    try {
      const result = await driver.execOp(opData, ctx.tabId)
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
      await driver.goBack()
      ctx.emit('result', '已后退')
    } catch (error) {
      ctx.emit('error', message(error))
    }
    return null
  }

  const forwardPage: BlockExecutor = async (_data, ctx) => {
    assertActive(ctx)
    try {
      await driver.goForward()
      ctx.emit('result', '已前进')
    } catch (error) {
      ctx.emit('error', message(error))
    }
    return null
  }

  const tabUrlExec: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const variable = String(data['variableName'] ?? 'lastTabUrl')
    // `scope` is the tool-schema key; `type` is the edit form's drifted name.
    const scopeKey = String(data['scope'] ?? data['type'] ?? 'active-tab')
    try {
      const tabs = driver.listTabs()
      const current =
        scopeKey === 'all'
          ? tabs
          : (tabs.find((tab) => tab.id === (ctx.tabId ?? driver.activeTabId())) ??
            tabs[tabs.length - 1])
      // The block's name promises a URL: storing the tab OBJECT made every
      // downstream `{{u}}` render as `[object Object]`.
      ctx.variables[variable] = Array.isArray(current)
        ? current.map((tab) => String(tab.url ?? '')).join('\n')
        : (current?.url ?? '')
      ctx.emit(
        'result',
        Array.isArray(current) ? `共 ${current.length} 个标签页` : (current?.url ?? ''),
      )
    } catch (error) {
      ctx.emit('error', message(error))
    }
    return null
  }

  const activeTabExec: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const variable = String(data['variableName'] ?? 'lastActiveTab')
    try {
      const info = await driver.activeInfo()
      ctx.variables[variable] = info
      ctx.emit('result', `${info.title} · ${info.url}`)
    } catch (error) {
      ctx.emit('error', message(error))
    }
    return null
  }

  const newWindowExec: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    // Headless "windows" are pages; a new window is a new page in the session.
    const url = data['url']
      ? interpolate(String(data['url']), ctx.variables, ctx.refData)
      : undefined
    try {
      const tab = await driver.newTab(url)
      ctx.setTab?.(tab.id)
      ctx.emit('result', `已打开新窗口 (${url ?? '空白页'})`)
    } catch (error) {
      ctx.emit('error', message(error))
    }
    return null
  }

  const createElementExec: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const html = interpolate(String(data['html'] ?? ''), ctx.variables, ctx.refData)
    const op: Op = { action: 'create_element', value: html }
    // The form has three content fields, not one: `css` becomes a `<style>` and
    // `javascript` runs against each created element. Only `html` reached the page.
    const css = interpolate(String(data['css'] ?? ''), ctx.variables, ctx.refData)
    const javascript = interpolate(String(data['javascript'] ?? ''), ctx.variables, ctx.refData)
    if (css.trim() !== '') op.css = css
    if (javascript.trim() !== '') op.javascript = javascript
    return runRaw(op, ctx)
  }

  const uploadFileExec: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const selector = sel(data)
    if (!selector) throw new Error('upload-file: missing selector')

    const rawMode = String(data['sourceMode'] ?? '').trim()
    const sourceMode: 'user-select' | 'workflow-file' =
      rawMode === 'workflow-file'
        ? 'workflow-file'
        : rawMode === 'user-select'
          ? 'user-select'
          : data['fileData'] !== undefined
            ? 'workflow-file'
            : 'user-select'

    if (sourceMode === 'user-select') {
      // The headless server has no UI to pick a local file.
      throw new Error(
        'upload-file: user-select mode is unavailable in the headless server; use workflow-file mode.',
      )
    }

    const fileVariable = String(data['fileVariable'] ?? '').trim()
    let raw: unknown
    if (fileVariable) {
      if (!(fileVariable in ctx.variables)) {
        throw new Error(`upload-file: variable "${fileVariable}" is not set.`)
      }
      raw = ctx.variables[fileVariable]
    } else if (data['fileData'] !== undefined) {
      raw = interpolate(String(data['fileData'] ?? ''), ctx.variables, ctx.refData)
    } else {
      throw new Error('upload-file: workflow-file mode requires a fileVariable.')
    }

    const files = normalizeWorkflowFiles(raw)
    const payloads = files.map((f) => {
      const payload = dataUrlToFilePayload(f.dataUrl)
      if (!payload) throw new Error(`upload-file: invalid data URL for "${f.name}"`)
      return {
        name: f.name,
        mimeType: f.mimeType || payload.mimeType,
        buffer: payload.buffer,
      }
    })

    const page = driver.pageForUpload(ctx.tabId)
    const locator = page.locator(selector).first()
    await locator.setInputFiles(payloads as unknown as Parameters<typeof locator.setInputFiles>[0])
    ctx.emit('result', `Uploaded ${payloads.length} file(s)`)
    return null
  }

  const handleDialogExec: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    // Playwright auto-accepts every dialog at the page level (unattended);
    // the kernel handler is still invoked with the block's own accept/prompt
    // settings, so in-page confirm()/prompt() overrides honour them for parity.
    const op: Op = { action: 'handle_dialog', accept: data['accept'] !== false }
    const promptText = interpolate(String(data['promptText'] ?? ''), ctx.variables, ctx.refData)
    if (promptText !== '') op.value = promptText
    return runRaw(op, ctx)
  }

  // --- Data / variable operations (ported) --------------------------------------

  const increaseVariable: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const name = String(data['variableName'] ?? '')
    if (!name) {
      throw new Error('increase-variable: 缺少 variableName，无法执行')
    }
    const step = Number(
      interpolate(String(data['increaseBy'] ?? data['value'] ?? '1'), ctx.variables, ctx.refData),
    )
    // Mirrors the extension, including the absent-variable case: `multiply` starts
    // from the identity 1 so a fresh variable does not stay 0 forever.
    const isMultiply = data['incType'] === 'multiply'
    const current = Number(ctx.variables[name] ?? (isMultiply ? 1 : 0))
    const next = isMultiply ? current * step : current + step
    ctx.variables[name] = Number.isNaN(next) ? 0 : next
    ctx.emit('result', `${name} = ${next}`)
    return null
  }

  const sliceVariable: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const name = String(data['variableName'] ?? '')
    // `startIndex`/`endIndex` (+ `…IdxEnabled` toggles) are the editor's keys;
    // `start`/`end` are legacy names kept as fallbacks.
    const hasLegacyEnd = data['end'] !== undefined && data['end'] !== ''
    const startEnabled = data['startIdxEnabled'] !== false
    const endEnabled =
      data['endIdxEnabled'] === true || (data['endIdxEnabled'] === undefined && hasLegacyEnd)
    const start = startEnabled ? Number(data['startIndex'] ?? data['start'] ?? 0) : 0
    const rawEnd = data['endIndex'] ?? data['end']
    const end = endEnabled && rawEnd !== '' && rawEnd !== undefined ? Number(rawEnd) : undefined
    const value = ctx.variables[name]
    let sliced: unknown
    if (typeof value === 'string') sliced = value.slice(start, end)
    else if (Array.isArray(value)) sliced = value.slice(start, end)
    else throw new Error(`slice-variable: 变量 ${name} 不存在或不是字符串/数组，无法执行`)
    ctx.variables[String(data['output'] ?? name)] = sliced
    ctx.emit('result', String(sliced ?? ''))
    return null
  }

  const regexVariable: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const name = String(data['variableName'] ?? '')
    const pattern = String(data['expression'] ?? data['pattern'] ?? '')
    const flags = String(data['flag'] ?? data['flags'] ?? 'g')
    const replace = interpolate(
      String(data['replaceVal'] ?? data['replace'] ?? ''),
      ctx.variables,
      ctx.refData,
    )
    const value = String(ctx.variables[name] ?? '')
    try {
      const regex = new RegExp(pattern, flags)
      let result: string
      if (String(data['method'] ?? data['operation'] ?? 'match') === 'replace')
        result = value.replace(regex, replace)
      else {
        // `String(value.match(/re/))` without the `g` flag returns only the
        // first match, so the global list has to be taken with the flags the
        // user chose; stripping `g` here made "match all" return one item.
        const all =
          flags.indexOf('g') !== -1
            ? (value.match(regex) ?? [])
            : (value.match(new RegExp(pattern, flags.replace('g', ''))) ?? []).slice(0, 1)
        result = JSON.stringify(all.map((m) => String(m)))
      }
      ctx.variables[String(data['output'] ?? name)] = result
      ctx.emit('result', result.slice(0, 80))
    } catch (error) {
      ctx.emit('error', `regex: ${message(error)}`)
    }
    return null
  }

  const tableOf = (ctx: WorkflowExecCtx): unknown[] =>
    Array.isArray(ctx.variables['dataTable']) ? (ctx.variables['dataTable'] as unknown[]) : []

  const deleteDataExec: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    // Mirror of the extension executor: the editor writes `deleteList` items
    // `{ type, columnId, variableName }`, never the row index read here before.
    const items = readRecordList(data['deleteList'])
    let removedColumns = 0
    let removedVariables = 0
    for (const item of items) {
      const record = (item ?? {}) as Record<string, unknown>
      if (String(record['type'] ?? 'table') === 'variable') {
        const name = String(record['variableName'] ?? '').trim()
        if (name !== '' && name in ctx.variables) {
          delete ctx.variables[name]
          removedVariables += 1
        }
        continue
      }
      const column = String(record['columnId'] ?? '[all]').trim()
      if (column === '' || column === '[all]') {
        ctx.variables['dataTable'] = []
        removedColumns += 1
        continue
      }
      for (const row of tableOf(ctx)) {
        if (row && typeof row === 'object') delete (row as Record<string, unknown>)[column]
      }
      removedColumns += 1
    }
    ctx.emit(
      'result',
      `已删除 ${removedColumns} 列 / ${removedVariables} 个变量${removedColumns + removedVariables === 0 ? '（未配置删除项）' : ''}`,
    )
    return null
  }

  const sortDataExec: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    // Mirror of the extension executor — `itemProperties` (`{ name, order }`)
    // over `dataSource` / `varSourceName`, not the invented `field` key.
    const fromVariable = String(data['dataSource'] ?? 'table') === 'variable'
    const sourceName = String(data['varSourceName'] ?? '').trim()
    const target = fromVariable
      ? readRecordList(ctx.variables[sourceName])
      : ((ctx.variables['dataTable'] as unknown[]) ?? [])
    const keys = readRecordList(data['itemProperties']).map((property) => {
      const record = (property ?? {}) as Record<string, unknown>
      return {
        field: String(record['name'] ?? ''),
        direction: String(record['order'] ?? 'asc') === 'desc' ? -1 : 1,
      }
    })
    const criteria =
      data['sortByProperty'] === true && keys.length > 0 ? keys : [{ field: '', direction: 1 }]
    const rows = [...target]
    rows.sort((left, right) => compareDataItems(left, right, criteria))
    if (fromVariable && sourceName !== '') ctx.variables[sourceName] = rows
    else ctx.variables['dataTable'] = rows
    applyAssignVariable(data, ctx.variables, rows)
    ctx.emit('result', `已按 ${criteria[0]?.field || '值'} 排序（${rows.length} 行）`)
    return null
  }

  const dataMapping: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    // Mirror of the extension executor: `sources[].destinations[]` renames
    // fields; the page-evaluated `mapping` expression read no editor key.
    const fromVariable = String(data['dataSource'] ?? 'table') === 'variable'
    const sourceName = String(data['varSourceName'] ?? '').trim()
    const rows = (fromVariable ? readRecordList(ctx.variables[sourceName]) : tableOf(ctx)).filter(
      (row): row is Record<string, unknown> => !!row && typeof row === 'object',
    )
    const renames = readRecordList(data['sources']).flatMap((source) => {
      const record = (source ?? {}) as Record<string, unknown>
      const from = String(record['name'] ?? '').trim()
      if (from === '') return []
      return readRecordList(record['destinations'])
        .map((destination) =>
          String((destination as Record<string, unknown>)?.['name'] ?? '').trim(),
        )
        .filter((to) => to !== '' && to !== from)
        .map((to) => ({ from, to }))
    })
    const mapped = rows.map((row) => {
      const next: Record<string, unknown> = { ...row }
      for (const { from, to } of renames) {
        if (!(from in next)) continue
        next[to] = next[from]
        delete next[from]
      }
      return next
    })
    if (fromVariable && sourceName !== '') ctx.variables[sourceName] = mapped
    applyAssignVariable(data, ctx.variables, mapped)
    ctx.variables['lastMappedData'] = mapped
    ctx.emit('result', `已映射 ${mapped.length} 行（${renames.length} 个字段改名）`)
    return null
  }

  const logData: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    // Mirror of the extension executor: the catalog promises the run's recent
    // log entries, and only the current run's log exists in either host.
    const wanted = String(data['workflowId'] ?? '').trim()
    if (wanted !== '') {
      throw new Error(`log-data: 只保留当前运行的日志，工作流「${wanted}」的历史日志无法读取`)
    }
    const text = (ctx.getRunLog?.() ?? []).join('\n')
    applyAssignVariable(data, ctx.variables, text)
    if (data['saveData'] === true) {
      const column = String(data['dataColumn'] ?? '').trim()
      if (column !== '') {
        if (!Array.isArray(ctx.variables['dataTable'])) ctx.variables['dataTable'] = []
        const table = ctx.variables['dataTable'] as Record<string, unknown>[]
        table.push({ [column]: text })
      }
    }
    ctx.emit('info', text)
    return null
  }

  const workflowState: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    // The editor's field is `type` (get / set / stop-*), `op` is the tool-schema
    // name; reading only `op` made every editor-configured node fall through to
    // `get`, so "set the state" read it instead.
    const op = String(data['type'] ?? data['op'] ?? 'get')
    const variable = String(data['variableName'] ?? 'state')
    if (op === 'set') {
      const value = interpolate(String(data['value'] ?? ''), ctx.variables, ctx.refData)
      ctx.variables[variable] = value
      ctx.emit('result', `已设置状态 ${variable}`)
      return null
    }
    if (op === 'get') {
      const value = ctx.variables[variable]
      ctx.variables['lastState'] = value
      ctx.emit('result', String(value ?? ''))
      return null
    }
    // Stopping a run belongs to the scheduler, which no block can reach; the
    // `throwError` toggle says what the workflow wants when that happens.
    if (data['throwError'] === true) {
      const detail = interpolate(String(data['errorMessage'] ?? ''), ctx.variables, ctx.refData)
      throw new Error(detail.trim() === '' ? `workflow-state: 无法执行「${op}」` : detail)
    }
    throw new Error(`workflow-state: 「${op}」需要运行调度器接口，块内无法停止运行`)
  }

  const parameterPrompt: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    // The editor writes a `parameters` list (name / default / required); reading
    // `defaultValue` + `variableName` instead honoured none of what the form
    // configured. There is no prompt UI on the server — values arrive with the
    // run request — so this block's job here is the extension's: fill defaults
    // into the gaps and refuse to drive the page without a required input.
    const parameters = workflowParametersOf(data['parameters'])
    for (const param of parameters) {
      if (ctx.variables[param.name] !== undefined) continue
      const fallback = param.defaultValue ?? ''
      if (fallback !== '') {
        ctx.variables[param.name] = coerceInputValue(
          param,
          interpolate(fallback, ctx.variables, ctx.refData),
        )
      }
    }
    const missing = missingRequiredInputs(parameters, ctx.variables)
    if (missing.length > 0) {
      throw new Error(`parameter-prompt: 缺少必填输入：${missing.join('、')}`)
    }
    const prompt = interpolate(String(data['prompt'] ?? '请输入值'), ctx.variables, ctx.refData)
    ctx.emit('info', `需要输入：${prompt}（服务端通过 API 变量传入）`)
    for (const param of parameters) {
      ctx.emit('result', `${param.name}=${String(ctx.variables[param.name] ?? '')}`)
    }
    return null
  }

  const switchToExec: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    // `EditSwitchTo` writes `selector`; `frameSelector` is the tool-schema name.
    const frame = String(data['frameSelector'] ?? data['selector'] ?? '')
    ctx.emit('info', frame ? `已定位 iframe ${frame}` : '已定位到顶层页面')
    return null
  }

  const triggerEventExec: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const event = String(data['event'] ?? data['eventName'] ?? '')
    const detail = interpolate(String(data['detail'] ?? 'null'), ctx.variables, ctx.refData)
    return runRaw(
      { action: 'trigger_event', target: targetFrom(data), attribute: event, value: detail },
      ctx,
    )
  }

  const browserEvent: BlockExecutor = async (_data, ctx) => {
    assertActive(ctx)
    ctx.emit('error', 'browser-event: 页面事件监听依赖扩展常驻 content script，服务端不支持此块')
    return null
  }

  const handleDownload: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const filename = String(data['filename'] ?? '')
    const variable = String(data['variableName'] ?? 'lastDownload')
    // The block's own `timeout` field, like the extension: the port waited a
    // hardcoded 30s, so a node asking for 2s held the run for half a minute.
    const waitMs =
      data['waitForDownload'] === false ? 0 : Math.max(0, Number(data['timeout'] ?? 20000))
    try {
      const match = await driver.waitForDownload(filename || undefined, waitMs)
      ctx.variables[variable] = match
        ? { filename: match.filename, path: match.path, url: match.url }
        : null
      ctx.emit(
        'result',
        match
          ? `最近下载: ${match.filename}${match.path ? ` → ${match.path}` : ''}`
          : '未找到匹配下载',
      )
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
      ctx.emit('error', message(error))
    }
    return null
  }

  const saveAssetsExec: BlockExecutor = async (_data, ctx) => {
    assertActive(ctx)
    ctx.emit('info', 'save-assets: 资源保存为占位实现（服务端）')
    return null
  }

  const saveLocal: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const value = interpolate(String(data['value'] ?? ''), ctx.variables, ctx.refData)
    const filename = interpolate(String(data['filename'] || 'file.txt'), ctx.variables, ctx.refData)
    const variable = String(data['variableName'] ?? 'lastSavedPath')
    try {
      const path = writeArtifact(artifactsDir, filename, value)
      ctx.variables[variable] = path
      ctx.emit('result', `已保存: ${path}`)
    } catch (error) {
      ctx.emit('error', `保存失败: ${message(error)}`)
    }
    return null
  }

  const proxyExec: BlockExecutor = async (_data, ctx) => {
    assertActive(ctx)
    // Mirrors the extension: an info line plus `return null` is a green step that
    // changed nothing, which is the worst outcome for a block whose whole purpose
    // is to move traffic onto another exit.
    throw new Error(
      'proxy: 未实现 —— 扩展未声明 proxy 权限，服务端也仅能通过运行参数配置代理，本块无法改变网络出口；宁可直接失败，也不要在静默直连的情况下报告成功。',
    )
  }

  const unsupportedCloud =
    (blockId: string): BlockExecutor =>
    async (_data, ctx) => {
      ctx.emit('error', `Block "${blockId}" requires Automa's cloud service and is not supported.`)
      return null
    }

  const waitConnections: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    // Give a click/keypress-triggered navigation a short settle window first.
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) return resolve()
      const timer = setTimeout(resolve, 300)
      ctx.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
    await driver.waitForLoaded(ctx.tabId, Math.max(1000, Number(data['timeout'] ?? 10000)))
    ctx.emit('result', '页面已加载')
    return null
  }

  const note: BlockExecutor = async (data, ctx) => {
    const text = String(data['text'] ?? '')
    if (text) ctx.emit('info', text)
    return null
  }

  const blocksGroup: BlockExecutor = async () => null

  const getForm: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const variable = String(data['variableName'] ?? 'lastForm')
    const selector = sel(data) || undefined
    try {
      const op: Op = { action: 'read_form' }
      if (selector) op.value = selector
      const result = await driver.execOp(op, ctx.tabId)
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
    return runRaw(
      withWait({ action: 'set_checkbox', target: targetFrom(data), value: checked }, data),
      ctx,
    )
  }

  /** Emit an "info" notice and let the engine continue. */
  function placeholder(blockId: string): BlockExecutor {
    return (_data, ctx) => {
      ctx.emit('info', '尚未实现: ' + blockId)
      return Promise.resolve(null)
    }
  }

  /** The ai-agent block: the server agent loop (see agent/agent-loop.ts). */
  const aiAgentExecutor: BlockExecutor = (data, ctx) => runAgentTurnForBlock(data, ctx, deps)

  function describeBlockTarget(data: Record<string, unknown>): string {
    const selector = sel(data)
    if (selector) return selector
    const target = richTargetOf(data)
    if (target) return `${target.primary.how}|${target.primary.value}`
    return '(无定位)'
  }

  /** Human-readable form of a read value, for the run log. */
  function previewValue(value: unknown): string {
    if (typeof value === 'boolean') return value ? '已勾选' : '未勾选'
    if (Array.isArray(value)) return value.length ? value.map(String).join(', ') : '(空)'
    const text = String(value ?? '')
    return text === '' ? '(空)' : logPreview(text, 120)
  }

  /**
   * The form's "Get form value" mode (mirror of the extension's `readFormValue`):
   * read the control instead of writing it, keeping the native type so
   * downstream `conditions` can compare against it.
   */
  async function readFormValue(
    data: Record<string, unknown>,
    target: Target,
    ctx: WorkflowExecCtx,
  ): Promise<string | null> {
    const variable = String(data['variableName'] ?? '').trim()
    if (!variable) throw new Error('读取表单值需要填写变量名（variableName），无法读取')
    const result = await driver.execOp(withWait({ action: 'get_value', target }, data), ctx.tabId)
    if (result && result.ok === false) throw new Error(result.error || '读取表单值失败')
    ctx.variables[variable] = result?.data
    ctx.emit(
      'info',
      `[表单读取] ${describeBlockTarget(data)} → {{${variable}}} = ${previewValue(result?.data)}`,
    )
    ctx.emit('result', previewValue(result?.data))
    return null
  }

  const formsBlock: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const type = String(data['type'] ?? 'text-field')
    const value = data['value']
    const target = targetFrom(data)

    // Checked before the write path: that path fills `value`, which is empty in
    // read mode, so it would clear the very control being read.
    if (data['getValue'] === true) return readFormValue(data, target, ctx)

    if (type === 'checkbox' || type === 'radio') {
      // The editor's "Selected" toggle writes `selected`; only the legacy chat
      // shape writes `value`. Reading just `value` made unticking impossible.
      const checked =
        typeof data['selected'] === 'boolean'
          ? data['selected']
          : typeof value === 'boolean'
            ? value
            : true
      ctx.emit('info', `[表单输入] ${describeBlockTarget(data)} ← ${checked ? '勾选' : '取消勾选'}`)
      return runRaw(withWait({ action: 'set_checkbox', target, value: checked }, data), ctx)
    }
    const raw = String(value ?? '')
    const filled = interpolate(raw, ctx.variables, ctx.refData)
    if (raw.includes('{{') && filled.trim() === '') {
      ctx.emit('info', `[表单输入] 原值: ${logPreview(raw, 120) || '(空)'}`)
      ctx.emit('error', '表单值引用的变量/AI 结果为空，已跳过本次填写')
      return null
    }
    ctx.emit(
      'info',
      `[表单输入] ${describeBlockTarget(data)} ← ${logPreview(filled, 120) || '(空)'}`,
    )
    if (type === 'select') {
      const op = withWait({ action: 'select_option', target, value: filled }, data)
      // "Select an option by" also offers first / last / custom position, which
      // carry no value at all; sending only `value` left three of the four modes
      // unable to select anything.
      Object.assign(op, selectOptionFields(data))
      return runRaw(op, ctx)
    }
    return runRaw(
      withWait(
        { action: 'fill', target, value: filled, clear: data['clearValue'] !== false },
        data,
      ),
      ctx,
    )
  }

  const elementScroll: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const scroll = scrollSpecFrom(data)
    // The form's "Container selector" names the element that actually scrolls;
    // nothing read it, so a container scroll moved the window instead.
    const selector = sel(data) || String(data['containerSelector'] ?? '')
    if (selector === 'window' || selector === 'html') {
      return runRaw({ action: 'scroll', scroll }, ctx)
    }
    if (selector) {
      const target = sel(data) ? targetFrom(data) : targetFrom({ ...data, selector })
      if (data['scrollIntoView']) {
        return runRaw(
          withWait({ action: 'scroll', target, scroll: { mode: 'into_view' } }, data),
          ctx,
        )
      }
      return runRaw(withWait({ action: 'scroll', target, scroll }, data), ctx)
    }
    if (data['scrollIntoView'] && richTargetOf(data)) {
      return runRaw(
        withWait(
          { action: 'scroll', target: targetFrom(data), scroll: { mode: 'into_view' } },
          data,
        ),
        ctx,
      )
    }
    return runRaw({ action: 'scroll', scroll }, ctx)
  }

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
      // The editor writes an OR-group tree of builder items; the shared
      // evaluator also accepts the flat `{ name, compare, value }` rows a
      // generated graph writes, so both shapes answer the same way here.
      matched = await conditionGroupsMatch(data['conditions'], {
        vars: ctx.variables,
        runCode: async (source) => {
          const evaluated = await evalInPage(
            `return (${source});`,
            { vars: ctx.variables, refData: ctx.refData },
            ctx,
          )
          if (!evaluated.ok) throw new Error('conditions: 页面求值失败')
          return evaluated.value
        },
      })
    }
    ctx.emit('result', matched ? '条件成立' : '条件不成立')
    return matched
      ? (ctx.outputs?.['true'] ?? ctx.outputs?.['output-1'] ?? ctx.defaultNext ?? null)
      : (ctx.outputs?.['false'] ?? ctx.outputs?.['output-2'] ?? ctx.defaultNext ?? null)
  }

  const eventClick: BlockExecutor = async (data, ctx) =>
    runRaw(withWait({ action: 'click', target: targetFrom(data) }, data), ctx)
  const hoverElement: BlockExecutor = async (data, ctx) =>
    runRaw(withWait({ action: 'hover', target: targetFrom(data) }, data), ctx)

  const loopBreakpointExec: BlockExecutor = async (data) => {
    const raw = data['loopId']
    const loopId = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
    throw new LoopBreakpointError(loopId)
  }

  /** Launch triggers act as pass-through entry points. */
  const noop: BlockExecutor = async () => null

  return {
    // browser
    click: click,
    fill: fill,
    'select-option': selectOption,
    scroll: scroll,
    'press-key': pressKey,
    'wait-for': waitFor,
    'take-screenshot': takeScreenshot,
    'get-text': getText,
    'read-page': readPage,
    ocr: ocrBlock,
    hover: hover,
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
    condition: condition,
    'loop-data': placeholder('loop-data'),
    'repeat-task': placeholder('repeat-task'),
    'while-loop': placeholder('while-loop'),
    'loop-elements': placeholder('loop-elements'),
    delay: delay,
    breakpoint: breakpoint,
    // browser actions
    cookie: cookieBlock,
    clipboard: clipboardBlock,
    'element-exists': elementExistsExec,
    link: linkBlock,
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
    webhook: webhook,
    notification: notification,
    'javascript-code': javascriptCode,
    'ai-prompt': aiPrompt,
    'ai-agent': aiAgentExecutor,
    'execute-workflow': placeholder('execute-workflow'),
    'parameter-prompt': parameterPrompt,
    'switch-to': switchToExec,
    'trigger-event': triggerEventExec,
    'browser-event': browserEvent,
    'handle-download': handleDownload,
    'save-local': saveLocal,
    'save-assets': saveAssetsExec,
    proxy: proxyExec,
    'google-sheets': unsupportedCloud('google-sheets'),
    'google-drive': unsupportedCloud('google-drive'),
    'wait-connections': waitConnections,
    note: note,
    'blocks-group': blocksGroup,
    // Automa-catalog ids produced by the editor / recorder.
    trigger: noop,
    'event-click': eventClick,
    'hover-element': hoverElement,
    'element-scroll': elementScroll,
    forms: formsBlock,
    conditions: conditionsBlock,
    'loop-breakpoint': loopBreakpointExec,
    // trigger
    'visit-web': noop,
    schedule: noop,
    manual: noop,
    'context-menu': noop,
    'on-startup': noop,
    'keyboard-shortcut': noop,
    date: noop,
    'specific-day': noop,
    'element-change': noop,
  }
}
