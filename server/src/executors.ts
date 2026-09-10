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
import type { Op, ScrollSpec, Target, TargetSpec } from '../../src/lib/ops'
import type { RunnerConfig } from './config'
import type { RunDriver } from './driver'
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
    ...(typeof target.frameHint === 'string' && target.frameHint ? { frameHint: target.frameHint } : {}),
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
  provider: { apiKey: string; baseUrl: string; model: string; headers?: Record<string, string> } | null
}

// --- Local (off-page) workflow JS fallback (ported verbatim) --------------------

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

/** Evaluate one Automa condition row against runtime variables (ported). */
interface ConditionRow {
  type?: string
  compare?: string
  value?: unknown
  name?: string
}

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
      if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right)
      return String(left ?? '') === String(right ?? '')
  }
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
    const buffer = isBase64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8')
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

    if (mode === 'incremental') {
      const step = Math.max(1, Number(data['step'] ?? 120))
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x), Math.abs(y)) / step))
      for (let i = 0; i < steps; i += 1) {
        assertActive(ctx)
        const safe = { ...op, scroll: { mode: 'by' as const, x: x / steps, y: y / steps, smooth: true } }
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
    } catch (error) {
      ctx.emit('error', `截图失败: ${message(error)}`)
    }
    return null
  }

  const getText: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const selector = sel(data)
    const result = await driver.execJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.textContent ?? '').trim() : '' })()`,
      {},
      ctx.tabId,
    )
    const text = result.ok ? String(result.data ?? '') : ''
    ctx.variables['lastText'] = text
    ctx.emit('result', text)
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
        ctx.emit('error', `ocr: 变量 ${name} 不是可识别的图片（支持 base64、data URL 或 http(s) 图片链接）`)
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

  const newTabExec: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const url = data['url'] ? String(data['url']) : undefined
    try {
      const tab = await driver.newTab(url)
      ctx.setTab?.(tab.id)
      if (url && data['waitTabLoaded'] !== false) {
        await driver.waitForLoaded(tab.id)
      }
      ctx.emit('result', `已打开 ${url ?? '新标签页'} (tab #${tab.id})`)
    } catch (error) {
      ctx.emit('error', message(error))
    }
    return null
  }

  const switchTabExec: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    try {
      const tab = await driver.switchTab(Number(data['index'] ?? 0))
      ctx.setTab?.(tab.id)
      ctx.emit('result', `已切换到标签页 #${tab.id} (${tab.url})`)
    } catch (error) {
      ctx.emit('error', message(error))
    }
    return null
  }

  const closeTabExec: BlockExecutor = async (_data, ctx) => {
    assertActive(ctx)
    try {
      await driver.closeActiveTab()
      ctx.emit('result', '已关闭当前标签页')
    } catch (error) {
      ctx.emit('error', message(error))
    }
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
    // Server convenience on top of the extension contract: the export also
    // lands in the run's artifacts directory, so the file is retrievable.
    if (text) {
      const path = writeArtifact(artifactsDir, `export-${Date.now()}.${format === 'json' ? 'json' : 'csv'}`, text)
      ctx.emit('info', `已写出文件: ${path}`)
    }
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
    const responseVariable = String(data['responseVariable'] ?? 'lastHttpResponse')

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
        const response = await fetch(url, { method, headers, body: bodyText, signal: controller.signal })
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
      ctx.emit('result', typeof local.result === 'string' ? local.result : safeStringify(local.result))
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
    const op = String(data['op'] ?? 'get')
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

  const clipboardBlock: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const op = String(data['op'] ?? 'get')
    try {
      if (op === 'get') {
        const text = await driver.clipboardGet()
        ctx.variables[String(data['variableName'] ?? 'lastClipboard')] = text
        ctx.emit('result', text.slice(0, 80))
      } else {
        const text = interpolate(String(data['text'] ?? ''), ctx.variables, ctx.refData)
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
    const newTab = (data['newTab'] as boolean | undefined) ?? true
    try {
      const result = await driver.execOp({ action: 'click_link', target: cssTarget(selector) }, ctx.tabId)
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
        await runRaw(withWait({ action: 'click', target: cssTarget(selector) }, data), ctx)
        if (waitLoaded) await driver.waitForLoaded(ctx.tabId)
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
    try {
      const tabs = driver.listTabs()
      const current =
        data['scope'] === 'all'
          ? tabs
          : (tabs.find((tab) => tab.id === (ctx.tabId ?? driver.activeTabId())) ?? tabs[tabs.length - 1])
      ctx.variables[variable] = current
      ctx.emit('result', Array.isArray(current) ? `共 ${current.length} 个标签页` : (current?.url ?? ''))
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
    const url = data['url'] ? interpolate(String(data['url']), ctx.variables, ctx.refData) : undefined
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
    return runRaw({ action: 'create_element', value: html }, ctx)
  }

  const uploadFileExec: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const selector = sel(data)
    const dataUrl = interpolate(String(data['fileData'] ?? ''), ctx.variables, ctx.refData)
    try {
      const payload = dataUrlToFilePayload(dataUrl)
      if (!payload) {
        ctx.emit('error', 'upload-file: fileData 需要是 data: URL（base64）')
        return null
      }
      const page = driver.pageForUpload(ctx.tabId)
      const locator = page.locator(selector).first()
      await locator.setInputFiles({
        name: `${payload.name}.${mimeTypeExtension(payload.mimeType)}`,
        mimeType: payload.mimeType,
        buffer: payload.buffer,
      })
      ctx.emit('result', '已设置文件输入')
    } catch (error) {
      ctx.emit('error', message(error))
    }
    return null
  }

  const handleDialogExec: BlockExecutor = async (_data, ctx) => {
    assertActive(ctx)
    // Playwright auto-accepts every dialog at the page level (unattended);
    // the kernel handler is still invoked for parity with flows that check it.
    return runRaw({ action: 'handle_dialog' }, ctx)
  }

  // --- Data / variable operations (ported) --------------------------------------

  const increaseVariable: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const name = String(data['variableName'] ?? '')
    const step = Number(interpolate(String(data['value'] ?? '1'), ctx.variables, ctx.refData))
    const current = Number(ctx.variables[name] ?? (data['incType'] === 'multiply' ? 1 : 0))
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

  const tableOf = (ctx: WorkflowExecCtx): unknown[] =>
    Array.isArray(ctx.variables['dataTable']) ? (ctx.variables['dataTable'] as unknown[]) : []

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

  const parameterPrompt: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const prompt = interpolate(String(data['prompt'] ?? '请输入值'), ctx.variables, ctx.refData)
    const fallback = interpolate(String(data['defaultValue'] ?? ''), ctx.variables, ctx.refData)
    const variable = String(data['variableName'] ?? 'userInput')
    if (ctx.variables[variable] === undefined && fallback !== '') ctx.variables[variable] = fallback
    ctx.emit('info', `需要输入：${prompt}（服务端通过 API 变量传入）`)
    ctx.emit('result', String(ctx.variables[variable] ?? ''))
    return null
  }

  const switchToExec: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
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
    ctx.emit('error', 'browser-event: 页面事件监听依赖扩展常驻 content script，服务端不支持此块')
    return null
  }

  const handleDownload: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const filename = String(data['filename'] ?? '')
    const variable = String(data['variableName'] ?? 'lastDownload')
    try {
      const match = await driver.waitForDownload(filename || undefined, 30_000)
      ctx.variables[variable] = match ? { filename: match.filename, path: match.path, url: match.url } : null
      ctx.emit('result', match ? `最近下载: ${match.filename}${match.path ? ` → ${match.path}` : ''}` : '未找到匹配下载')
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
    ctx.emit('info', 'proxy: 服务端代理通过运行参数/API 配置（per-context proxy），块内不生效')
    return null
  }

  const unsupportedCloud = (blockId: string): BlockExecutor => async (_data, ctx) => {
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
    return runRaw({ action: 'set_checkbox', target: targetFrom(data), value: checked }, ctx)
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

  const formsBlock: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const type = String(data['type'] ?? 'text-field')
    const value = data['value']
    const target = targetFrom(data)

    if (type === 'checkbox' || type === 'radio') {
      const checked = typeof value === 'boolean' ? value : true
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
    ctx.emit('info', `[表单输入] ${describeBlockTarget(data)} ← ${logPreview(filled, 120) || '(空)'}`)
    if (type === 'select') {
      return runRaw(withWait({ action: 'select_option', target, value: filled }, data), ctx)
    }
    return runRaw(
      withWait({ action: 'fill', target, value: filled, clear: data['clearValue'] !== false }, data),
      ctx,
    )
  }

  const elementScroll: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const x = Number(data['scrollX'] ?? 0)
    const y = Number(data['scrollY'] ?? 0)
    const smooth = data['smooth'] === true
    const selector = sel(data)
    if (selector === 'window' || selector === 'html') {
      return runRaw({ action: 'scroll', scroll: { mode: 'by', x, y, smooth } }, ctx)
    }
    if (selector) {
      if (data['scrollIntoView']) {
        return runRaw(withWait({ action: 'scroll', target: targetFrom(data), scroll: { mode: 'into_view' } }, data), ctx)
      }
      return runRaw(
        withWait({ action: 'scroll', target: targetFrom(data), scroll: { mode: 'by', x, y, smooth } }, data),
        ctx,
      )
    }
    if (data['scrollIntoView'] && richTargetOf(data)) {
      return runRaw(withWait({ action: 'scroll', target: targetFrom(data), scroll: { mode: 'into_view' } }, data), ctx)
    }
    return runRaw({ action: 'scroll', scroll: { mode: 'by', x, y, smooth } }, ctx)
  }

  const conditionsBlock: BlockExecutor = async (data, ctx) => {
    assertActive(ctx)
    const code = data['code'] as string | undefined
    let matched = false
    if (code) {
      const evaluated = await evalInPage(`return (${code})`, { vars: ctx.variables, refData: ctx.refData }, ctx)
      matched = evaluated.ok ? Boolean(evaluated.value) : false
    } else {
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
    'click': click,
    'fill': fill,
    'select-option': selectOption,
    'scroll': scroll,
    'press-key': pressKey,
    'wait-for': waitFor,
    'take-screenshot': takeScreenshot,
    'get-text': getText,
    'ocr': ocrBlock,
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
    // browser actions
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
    'ai-agent': aiAgentExecutor,
    'execute-workflow': placeholder('execute-workflow'),
    'parameter-prompt': parameterPrompt,
    'switch-to': switchToExec,
    'trigger-event': triggerEventExec,
    'browser-event': browserEvent,
    'handle-download': handleDownload,
    'save-local': saveLocal,
    'save-assets': saveAssetsExec,
    'proxy': proxyExec,
    'google-sheets': unsupportedCloud('google-sheets'),
    'google-drive': unsupportedCloud('google-drive'),
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
    'loop-breakpoint': loopBreakpointExec,
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
}

// --- Helpers ---------------------------------------------------------------------

function mimeTypeExtension(mimeType: string): string {
  const table: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/csv': 'csv',
  }
  return table[mimeType] ?? 'bin'
}
