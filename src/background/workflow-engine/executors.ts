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
 * ## 失败必须抛错，不能只 `ctx.emit('error', …)`
 *
 * `emit('error')` 只是往运行日志写一行；引擎判定的失败路径**只有一条**——
 * 执行器抛出的异常（`engine.ts` 的 `catch (e) → !succeeded`）。所以
 * `ctx.emit('error', …); return null` 会让整轮运行继续按**成功**收尾，
 * 并且有两个后果：
 *
 *   1. 重放时用户看到「运行成功」，但产物是空的，日志里那行红字很容易被忽略；
 *   2. 生成时更糟——算子桥接（`operator-exec.ts`）按 `status` 判断，
 *      `emit` 过的节点仍是 `'executed'`，于是**坏节点照样被记进草稿**，
 *      模型以为这一步成功了，最后交付一个不可用的工作流。
 *
 * 因此：**本节点的主操作失败 → `throw`**。引擎会按节点自己的 onError 策略
 * 处理（retry / fallback / continue / error），算子桥接会返回 `ok:false` +
 * 错误消息，草稿保持不变，模型可以换个定位符重试。动作类执行器经 `runRaw`
 * 本来就是这么做的（见其注释），其余块与它保持一致。
 *
 * 例外（有意保留的降级，不抛错）：`scroll` 的增量滚动中途失败只 `break`
 * 提前结束本次滚动；`read-page` 的「选中文本」模式空选区只提示（没有声明式
 * 的守卫算子能测「用户选没选」）。
 *
 * @module background/workflow-engine/executors
 */

import { isInjectablePage } from '../../lib/pages'
import { truncate } from '../../lib/extract'
import { streamCompletion, type WireMessage } from '../../lib/llm'
import { getSettings, listPasswords } from '../../lib/storage'
import { entryFields, findField } from '../../lib/types'
import { OCR_SUPPORTED } from '../../lib/ocr-support'
import { interpolate, EMPTY_INTERP_KEY, getByPath } from '../../lib/workflow/interpolate'
import { interpretScriptResult } from '../../lib/workflow/script-result'
import {
  coerceInputValue,
  missingRequiredInputs,
  workflowParametersOf,
} from '../../lib/workflow/workflow-inputs'
import { sanitizeModelAnswer } from '../../lib/model-output'
import { preprocessImage } from '../../lib/vision'
import { LoopBreakpointError } from './loop-breakpoint'
import {
  askSaveViaSidePanel,
  getDownloadDir,
  writeFileToDownloadDir,
  type SavePickerPayload,
} from '../../lib/download-dir'
import { aiAgent } from './ai-agent-executor'
import type { Op, ScrollSpec, Target, TargetSpec } from '../../lib/ops'
import { resolveTargetTab, readActivePage, readActiveSelection } from '../page'
import { captureVisiblePage } from '../capture'
import { captureElementRobust, imageHasInk } from '../element-capture'
import type { ScopeWindow } from '../automation-scope'
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
  ocrImage,
  resolveAutomationTab,
  newWindow as driverNewWindow,
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
  /**
   * Panel-window scope for this run: every tab resolution, tab op and page
   * action stays inside this window (undefined = legacy global resolution for
   * unattended runs). Validated once by the run layer; the engine only
   * threads it through.
   */
  scope?: ScopeWindow
  /** Pin the target tab (called by new-tab / link / switch-tab executors). */
  setTab?: (tabId: number) => void
  /**
   * Snapshot the current variables for a block (debug mode). Called by the
   * engine after each block; the run layer collects them so the logs viewer can
   * show the variable values at each step.
   */
  snapshot?: (nodeId: string, label: string, variables: Record<string, unknown>) => void
  /**
   * The workflow's resolved reliability contract (see
   * `lib/workflow/reliability`). Present only on generated-strict runs: every
   * element op then carries the strict resolve policy, so the kernel refuses
   * ambiguous matches instead of acting on the first of many. Absent = the
   * legacy compat behavior, bit for bit.
   */
  reliability?: {
    mode: 'generated-strict'
    ambiguity: 'error' | 'score' | 'first-visible'
    minScore: number
    minMargin: number
  }
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
 * The conversation's rich locator stored on generated nodes (`storage.ts`
 * keeps the agent's `args.target` under `data.target`). Valid when its
 * primary spec is resolvable; the kernel handles every strategy natively
 * (role, text, testid, …), so it is used as-is when no selector exists and
 * becomes fallbacks behind the editable selector otherwise.
 */
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

/**
 * Build a `Target` from a block's data. XPath locators are encoded with an
 * `xpath:` prefix the kernel resolves; CSS uses the css strategy.
 *
 * Nodes generated from a conversation can carry the agent's original rich
 * locator under `data.target` (role/text specs a CSS selector cannot
 * express). It never overrides the editable selector: a non-empty `selector`
 * stays the primary and the rich specs become fallbacks; with no selector
 * the rich target is used as-is.
 */
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
    const result = await execJsOnActiveTab(code, args, ctx.signal, ctx.tabId, ctx.scope)
    if (result.ok) return { ok: true, value: result.data }
    ctx.emit('error', `JS 执行失败: ${result.error ?? '未知错误'}`)
    return { ok: false }
  } catch (error) {
    ctx.emit('error', `JS 执行失败: ${message(error)}`)
    return { ok: false }
  }
}

/**
 * Run one op on the active tab and report the outcome.
 *
 * The kernel never throws — failures come back as `ok: false` with a message
 * (element not matched, action refused). A failed op is raised as a block
 * error so the engine's onError machinery (retry / fallback / continue /
 * fail) applies and a click that never happened no longer reads as success.
 * Driver-level errors (no usable tab, injection failure) propagate the same
 * way, and an aborted signal keeps its cancellation semantics upstream. A
 * click that navigated mid-call is reported by the driver as `ok: true` with
 * a note — still a success, by design.
 */
/**
 * The strict resolve policy an element op carries on a generated-strict run,
 * or `undefined` on a compat run (the kernel then keeps the legacy resolver).
 */
function resolvePolicyOf(ctx: WorkflowExecCtx): Op['resolvePolicy'] {
  const reliability = ctx.reliability
  if (!reliability) return undefined
  return {
    mode: 'strict',
    ambiguity: reliability.ambiguity,
    minScore: reliability.minScore,
    minMargin: reliability.minMargin,
  }
}

async function runRaw(op: Op, ctx: WorkflowExecCtx): Promise<string | null> {
  assertActive(ctx)
  const policy = resolvePolicyOf(ctx)
  const result = await execOnActiveTab(
    policy ? { ...op, resolvePolicy: policy } : op,
    ctx.signal,
    ctx.tabId,
    ctx.scope,
  )
  if (result && result.ok === false) {
    throw new Error(result.error || `${op.action} 失败`)
  }
  ctx.emit('result', result?.note ?? 'ok')
  return null
}

/**
 * Top-level injected function for the `get-text` block. No closure.
 *
 * Always returns an array — one entry per matched element — because the block's
 * `multiple` flag used to be silently ignored and a scalar return left no way
 * for the caller to tell "one match" from "the first of many". The single-read
 * case is simply a one-element array.
 */
function readTextsInPage(
  selector: string,
  multiple: boolean,
  useTextContent: boolean,
  includeTags: boolean,
): string[] {
  const nodes = selector ? Array.from(document.querySelectorAll(selector)) : []
  if (nodes.length === 0) return []
  const picked = multiple ? nodes : nodes.slice(0, 1)
  return picked.map((node) => {
    const el = node as HTMLElement
    if (includeTags) return el.innerHTML ?? ''
    if (useTextContent) return el.textContent ?? ''
    // `innerText` is the RENDERED text, which is what the block's description
    // promises; `textContent` also returns hidden nodes and script bodies. Fall
    // back to `textContent` for a hidden element, where `innerText` is ''.
    return el.innerText || el.textContent || ''
  })
}

/** Top-level injected function for `read-page`'s HTML mode. No closure. */
function readHtmlInPage(selector: string): string {
  const el = selector ? document.querySelector(selector) : document.documentElement
  return el ? el.outerHTML : ''
}

/**
 * Cap on a data-table row index, so a corrupt `loopIndex` cannot make the
 * fill loop below allocate forever.
 */
const MAX_TABLE_ROWS = 100_000

/**
 * Append read values into the data table — the ONLY thing `export-data` reads,
 * so a read that does not land here leaves the export empty.
 *
 * Rows are addressed by index, and which index depends on context:
 *
 *   - inside a loop, the current `loopIndex` — one row per iteration, which is
 *     what "read one column per iteration" means;
 *   - outside a loop, the match index — `multiple: true` yields one row per
 *     match.
 *
 * Writing a column onto a row that already exists REPLACES that cell instead of
 * appending a row, so
 * `get-text(multiple, dataColumn:'内容') → get-text(multiple, dataColumn:'热度')`
 * produces a two-column table rather than doubling the row count.
 *
 * @returns how many rows were created, for the run log.
 */
function collectIntoDataTable(
  ctx: WorkflowExecCtx,
  column: string,
  values: readonly string[],
): number {
  if (!column) return 0
  if (!Array.isArray(ctx.variables['dataTable'])) ctx.variables['dataTable'] = []
  const table = ctx.variables['dataTable'] as Record<string, unknown>[]
  const loopIndex = ctx.variables['loopIndex']
  const inLoop = typeof loopIndex === 'number' && Number.isFinite(loopIndex)
  let created = 0
  values.forEach((value, i) => {
    const rowIndex = Math.floor(inLoop ? (loopIndex as number) : i)
    if (rowIndex < 0 || rowIndex > MAX_TABLE_ROWS) return
    while (table.length <= rowIndex) {
      table.push({})
      created += 1
    }
    table[rowIndex]![column] = value
  })
  return created
}

/**
 * Write a read result to its output variable and, when the node asked for it,
 * into the data table. Shared by `get-text` and `read-page` so the two cannot
 * disagree about what `saveData` / `dataColumn` mean.
 */
function publishRead(
  ctx: WorkflowExecCtx,
  data: Record<string, unknown>,
  values: readonly string[],
  fallbackVariable: string,
): void {
  const value: unknown = data['multiple'] === true ? values : (values[0] ?? '')
  const variable = String(data['variableName'] ?? '').trim() || fallbackVariable
  ctx.variables[variable] = value
  if (variable !== fallbackVariable) ctx.variables[fallbackVariable] = value
  if (data['saveData'] === true) {
    const column = String(data['dataColumn'] ?? '').trim()
    if (!column) {
      // Silently collecting nothing is how the export ends up empty with no
      // explanation; say so instead.
      ctx.emit('info', '未指定数据列名（dataColumn），本次读取未写入数据表')
    } else {
      ctx.emit('info', `已写入数据表列「${column}」${collectIntoDataTable(ctx, column, values)} 行`)
    }
  }
  ctx.emit('result', Array.isArray(value) ? value.join('\n') : String(value))
}

/**
 * Refuse to publish a read that produced nothing.
 *
 * A selector matching no element used to write `''` / `[]` and emit
 * `result ''`, so a scraper with a wrong selector produced an empty export
 * while the run reported 成功 and nothing anywhere said why. Two moments
 * mattered:
 *
 *   - at replay, the empty file had no explanation;
 *   - during generation it was worse — the operator bridge recorded the node
 *     anyway, so the model shipped a step that reads nothing.
 *
 * Throwing fixes both: the engine fails the node with this text, and the bridge
 * returns `ok:false` WITHOUT recording, so the model has to find a selector
 * that actually matches. A legitimately optional read is not an exception to
 * swallow — the operator guide's answer is `element-exists`, which routes
 * exists / notExists declaratively instead of letting a read spin empty.
 */
function requireReadMatch(what: string, values: readonly string[]): void {
  if (values.some((value) => String(value ?? '').trim() !== '')) return
  throw new Error(
    `${what} 没有读到任何内容。请依次排查：` +
      '① 选择器是否写对——页面改版、类名变化都会让它失效；' +
      '② 元素是否是页面加载后才由脚本渲染出来的——把这一步放到 wait-connections 或 delay 之后；' +
      '③ 读的是否是目标标签页——读取跟着本轮的标签页走，先用 new-tab 打开再读；' +
      '④ 元素是否在 iframe 内——当前只读主框架。' +
      '如果这一步本来就是「有则读、没有就跳过」，请改用 element-exists 分 exists / notExists 两路，' +
      '不要让读取节点空转。',
  )
}

/**
 * Default poll window (ms) for READ blocks (`get-text` / `attribute-value` /
 * `read-page`).
 *
 * Reads used to be single-shot: one `querySelectorAll`, and an empty result
 * failed the step. That was fine while a human paced the generation session
 * (seconds pass between two operator calls), but a replay runs back-to-back —
 * a read right after a click-triggered navigation raced the page's own
 * rendering and failed with "没有读到任何内容" before the element ever existed.
 * Interaction blocks have had a forced wait since `applyDefaultWaits`; reads
 * get the same treatment here, with a longer window on purpose: a read that
 * gives up fails its step AND every downstream consumer of the value.
 */
export const DEFAULT_READ_WAIT_MS = 5000

/** The poll window a read node should use. */
interface ReadWaitSource {
  waitForSelector?: unknown
  waitSelectorTimeout?: unknown
}

/**
 * Effective poll window for one read node: an explicit `waitForSelector:
 * false` opts out entirely (single attempt, the old behavior); a positive
 * `waitSelectorTimeout` wins over the default; anything else polls for
 * {@link DEFAULT_READ_WAIT_MS}.
 */
export function readWaitMsOf(data: ReadWaitSource): number {
  if (data.waitForSelector === false) return 0
  const explicit = Number(data.waitSelectorTimeout)
  return Number.isFinite(explicit) && explicit > 0 ? explicit : DEFAULT_READ_WAIT_MS
}

/**
 * Retry a read injection until it produces content or the window expires.
 *
 * Only an EMPTY result is retried — a thrown injection error (restricted page,
 * closed tab) propagates immediately, because retrying cannot fix those. The
 * final empty result is returned as-is so the caller's `requireReadMatch` (or
 * equivalent) produces the exact error text it always has.
 */
async function pollRead<T>(
  data: ReadWaitSource,
  ctx: { signal: AbortSignal },
  attempt: () => Promise<T>,
  isEmpty: (value: T) => boolean,
): Promise<T> {
  const windowMs = readWaitMsOf(data)
  let value = await attempt()
  if (!(windowMs > 0)) return value
  const deadline = Date.now() + windowMs
  while (isEmpty(value) && Date.now() < deadline) {
    await sleep(120, ctx.signal)
    value = await attempt()
  }
  return value
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
    let stoppedAt: string | undefined
    for (let i = 0; i < steps; i += 1) {
      assertActive(ctx)
      const safe = {
        ...op,
        scroll: { mode: 'by' as const, x: x / steps, y: y / steps, smooth: true },
      }
      try {
        await execOnActiveTab(safe, ctx.signal, ctx.tabId, ctx.scope)
      } catch (error) {
        // Deliberate degrade (the one place a failure is NOT rethrown): a
        // partial scroll has still moved the page, and the next node locates
        // its own element anyway, so stopping early beats failing the run.
        // Reported as a partial result rather than "完成", which used to be
        // claimed even after this break.
        stoppedAt = `第 ${i + 1}/${steps} 步：${message(error)}`
        break
      }
    }
    if (stoppedAt) ctx.emit('error', `增量滚动提前中止（${stoppedAt}）`)
    else ctx.emit('result', '增量滚动完成')
    return null
  }

  return runRaw(op, ctx)
}

const pressKey: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  // The catalog and the edit form both write `keys` (the recorder's combo) or
  // `keysToPress` (the free-text field); `key` is the shape the agent's own
  // history path produces. Reading only `key` meant this block silently
  // pressed nothing whenever it came from the editor or a generated node.
  const key = String(data['keys'] ?? data['keysToPress'] ?? data['key'] ?? '')
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
  // A wait that never saw the element must not read as success: both driver
  // errors and timeouts surface as block errors for the engine's onError
  // machinery (retry / continue / fallback / fail) to handle.
  const result = await execOnActiveTab(
    { action: 'wait_for', target: targetFrom(data) },
    ctx.signal,
    ctx.tabId,
    ctx.scope,
  )
  if (result?.found) ctx.emit('result', '元素已出现')
  else throw new Error('等待超时，元素未出现')
  return null
}

const takeScreenshot: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const type = (data['type'] as string | undefined) ?? 'page'
  const selector = sel(data)
  const variable = String(data['variableName'] ?? 'lastScreenshot')
  // `ext` (png / jpeg) and `quality` are edit-form fields. Only the visible-page
  // path can honour them: the in-page full-page / element capture always
  // produces a PNG, so asking for JPEG there must not be answered by naming a
  // PNG `.jpeg`.
  const wantsJpeg = String(data['ext'] ?? 'png') === 'jpeg'
  const quality = Number(data['quality'] ?? 100)

  let dataUrl: string | undefined
  let actualExt = 'png'

  // fullpage / element go through the in-page SVG->canvas capture path.
  if (type === 'fullpage' || type === 'element') {
    const op: Op = { action: 'capture' }
    if (type === 'element') {
      if (!selector) throw new Error('元素截图需要 CSS 选择器')
      op.value = selector
    }
    const result = await execOnActiveTab(op, ctx.signal, ctx.tabId, ctx.scope)
    if (!result.ok || typeof result.data !== 'string') {
      throw new Error(result.error ?? '截图失败')
    }
    dataUrl = result.data
    if (wantsJpeg) {
      ctx.emit('info', '整页/元素截图固定为 PNG，已按 .png 保存（JPEG 只对可视区域截图生效）')
    }
  } else {
    // Default: visible page snapshot. The shared capture helper restores a
    // minimized window, retries transient races and — on failure — surfaces the
    // underlying Chrome error instead of an opaque one.
    const capture = await captureVisiblePage(ctx.scope, {
      format: wantsJpeg ? 'jpeg' : 'png',
      ...(wantsJpeg ? { quality } : {}),
    })
    if (!capture.ok) {
      throw new Error(`截图失败: ${capture.error}`)
    }
    dataUrl = capture.dataUrl
    actualExt = wantsJpeg ? 'jpeg' : 'png'
  }

  ctx.variables[variable] = dataUrl
  ctx.emit('result', `已截图 (${type})`)

  // "Save to computer" + file name + format. These were pure decoration: the
  // capture only ever landed in a variable, so checking the box wrote nothing.
  if (data['saveToComputer'] === true) {
    const rawName = interpolate(String(data['fileName'] ?? ''), ctx.variables, ctx.refData).trim()
    const base = rawName || 'screenshot'
    const filename = /\.[a-z0-9]+$/i.test(base) ? base : `${base}.${actualExt}`
    const outcome = await writeProducedFile(
      'take-screenshot',
      filename,
      { base64: base64Body(dataUrl) },
      ctx,
    )
    if (outcome === 'saved') ctx.variables['lastScreenshotPath'] = filename
  }

  // "Insert to table" reuses the same collection contract as `get-text` /
  // `read-page`, so `export-data` can pick the column up.
  const column = String(data['dataColumn'] ?? '').trim()
  if (data['saveToColumn'] === true && column) {
    collectIntoDataTable(ctx, column, [dataUrl])
  }
  return null
}

const getText: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const selector = sel(data)
  if (!selector) {
    // A generated node may carry only the conversation's rich locator
    // (`data.target` with role/text specs). `targetFrom` can act on that, but
    // this reader runs `querySelectorAll` and can only use a CSS selector — so
    // say that instead of reading nothing and calling it a success.
    throw new Error(
      richTargetOf(data)
        ? 'get-text: 这个节点只有富定位符（target），而读取只支持 CSS 选择器，请补上 selector。'
        : 'get-text: 缺少 selector，不知道要读哪个元素。',
    )
  }
  // The run's target tab, not the window's active tab — see `resolveTargetTab`.
  // Reading the wrong tab is how `new-tab → get-text` returns nothing (or, when
  // the active tab is the extension's own editor page, fails outright).
  const tab = await resolveTargetTab(ctx.tabId, ctx.scope)
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('get-text: 没有可读的标签页')
  }
  const tabId: number = tab.id
  // Poll until the element renders (see `pollRead`): a replay reaches this read
  // immediately after the preceding navigation, and a single querySelectorAll
  // raced the page's own rendering.
  const values = await pollRead(
    data,
    ctx,
    async () => {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: readTextsInPage,
        args: [
          selector,
          data['multiple'] === true,
          data['useTextContent'] === true,
          data['includeTags'] === true,
        ],
      })
      return (injection?.result as string[] | undefined) ?? []
    },
    (result) => result.length === 0,
  )
  // Reading nothing is a failed step, not an empty result — see
  // `requireReadMatch`. Checked before `publishRead` so the empty value never
  // reaches the variable bag or the data table.
  requireReadMatch(`get-text(selector: "${selector}")`, values)
  // The block's declared output is `variableName` — the catalog, the editor and
  // the operator guide all say so — but this executor only ever wrote
  // `lastText`, so a generated node that named its variable produced a
  // `{{name}}` reference resolving to nothing at replay. Write the declared
  // name, and keep `lastText` populated for the workflows already built on it.
  //
  // `multiple` / `saveData` / `dataColumn` were in the same state: declared in
  // the catalog, given UI, documented in the operator guide's collection recipe
  // — and read by nobody, which is why `export-data` always wrote an empty
  // file. They now do what the guide says.
  publishRead(ctx, data, values, 'lastText')
  return null
}

/** The active tab's HTML, optionally scoped to one element, capped. */
async function readHtmlFromActiveTab(
  selector: string,
  maxChars: number,
  ctx: WorkflowExecCtx,
): Promise<string> {
  const tab = await resolveTargetTab(ctx.tabId, ctx.scope)
  if (!tab || typeof tab.id !== 'number') throw new Error('没有活动标签页')
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    func: readHtmlInPage,
    args: [selector],
  })
  // HTML whitespace is content, so unlike the text path this is not collapsed —
  // only capped, which is what keeps a huge document out of the variable bag.
  return truncate((injection?.result as string | undefined) ?? '', maxChars).text
}

/** The text of every element matching `selector` in the run's target tab. */
async function readTextsFromActiveTab(selector: string, ctx: WorkflowExecCtx): Promise<string[]> {
  const tab = await resolveTargetTab(ctx.tabId, ctx.scope)
  if (!tab || typeof tab.id !== 'number') throw new Error('没有活动标签页')
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    func: readTextsInPage,
    args: [selector, false, false, false],
  })
  return (injection?.result as string[] | undefined) ?? []
}

/**
 * `read-page` — the recordable form of the chat agent's `read_current_page`
 * tool.
 *
 * The tool only ever fed the model's own understanding, so a task that needed
 * the page's text *in the workflow* had no step to record: `get-text` reads one
 * element, and the model had no way to say "this whole page". Reading the page
 * is now a node like any other, and `saveData` lets it feed the table that
 * `export-data` writes.
 */
const readPage: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const source = String(data['source'] ?? 'text')
  const selector = String(data['selector'] ?? '').trim()
  const requested = Number(data['maxChars'])
  const maxChars = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 20000

  // A page that forbids injection (browser-internal, Web Store, local file)
  // fails this step and says why, rather than recording a node that silently
  // reads nothing at replay — so no catch here on purpose.
  let values: string[]
  if (source === 'selection') {
    values = [(await readActiveSelection(ctx.scope, ctx.tabId)).selection]
    // The one read that is allowed to come back empty: a selection can be
    // legitimately absent, and no declarative block can test "did the user
    // select anything" (element-exists works on elements). Reported loudly,
    // but not fatal.
    if (values.every((value) => !value.trim())) {
      ctx.emit('error', 'read-page: 当前没有选中任何文本（source: selection）——读取结果为空')
    }
  } else if (source === 'html') {
    // Poll only an empty element-scoped read; the full document is never empty
    // once the page exists, so polling it would only burn the window.
    values = [
      await pollRead(
        data,
        ctx,
        () => readHtmlFromActiveTab(selector, maxChars, ctx),
        // The full document is never empty once the page exists — only an
        // element-scoped read is worth polling.
        (html) => selector !== '' && html === '',
      ),
    ]
    requireReadMatch(
      selector ? `read-page(source: html, selector: "${selector}")` : 'read-page(source: html)',
      values,
    )
  } else if (selector) {
    // Element-scoped text: reading the page's own text would ignore the
    // scope, so go through the element reader instead.
    values = await pollRead(
      data,
      ctx,
      () => readTextsFromActiveTab(selector, ctx),
      (result) => result.length === 0,
    )
    requireReadMatch(`read-page(selector: "${selector}")`, values)
  } else {
    const page = await pollRead(
      data,
      ctx,
      () => readActivePage(maxChars, ctx.scope, ctx.tabId),
      (result) => !result.text.trim(),
    )
    if (page.truncated) ctx.emit('info', `页面正文超过 ${maxChars} 字，已截断`)
    values = [page.text]
    requireReadMatch('read-page(source: text)', values)
  }

  publishRead(ctx, data, values, 'lastReadPage')
  return null
}

/**
 * Normalizes a variable-supplied image reference into a data URL the offscreen
 * OCR can draw onto its canvas:
 *  - `data:image/...` values pass through as-is;
 *  - an http(s) link is fetched (the extension's host_permissions cover all
 *    http/https hosts) and re-encoded as a base64 data URL — 转成图片后识别;
 *  - a bare base64 payload is wrapped in a `data:image/png;base64,` header so
 *    the offscreen canvas can decode it.
 * Returns null for anything else. AbortError propagates for cancellation.
 */
async function imageInputToDataUrl(raw: string, signal: AbortSignal): Promise<string | null> {
  const value = raw.trim()
  if (!value) return null
  if (/^data:image\//i.test(value)) return value
  if (/^https?:\/\//i.test(value)) {
    try {
      // Credentials included, like the agent's recognize_image downloader:
      // captcha endpoints are commonly session-bound.
      const response = await fetch(value, { signal, credentials: 'include' })
      if (!response.ok) return null
      const contentType = response.headers.get('content-type') ?? ''
      const mime = contentType.startsWith('image/') ? contentType : 'image/png'
      const bytes = new Uint8Array(await response.arrayBuffer())
      let binary = ''
      const CHUNK = 0x8000
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
      }
      return `data:${mime};base64,${btoa(binary)}`
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

/**
 * Rect probe + crop math live in `../element-capture` (shared with the
 * agent's recognize/screenshot tools); `cropRectFor` is re-exported for the
 * editor-facing tests.
 */
export { cropRectFor } from '../element-capture'

/**
 * Captures an element's rendering as a PNG data URL via the shared robust
 * strategy (scroll into view → in-page SVG capture with `waitFor` polling →
 * visible-page capture + crop, retried — see ../element-capture). Progress
 * and the final reason surface through the run's error log.
 */
async function captureElementImage(selector: string, ctx: WorkflowExecCtx): Promise<string | null> {
  const result = await captureElementRobust(selector, {
    signal: ctx.signal,
    scope: ctx.scope,
    preferredTabId: ctx.tabId,
  })
  if (result.ok) return result.dataUrl
  throw new Error(`ocr: ${result.error}`)
}

/**
 * Automa-style `ocr` block (Browser Copilot extension): run local OCR
 * (Tesseract.js in the offscreen document — fully offline) and output the
 * recognized string.
 *
 * Input — exactly one of three sources, chosen by `source`:
 *  - `'variable'` — an img-typed variable (`imageVariable`) holding an image
 *    as a data URL, a bare base64 payload (wrapped for the canvas) or an
 *    http(s) link (fetched and re-encoded first), e.g. the output of a
 *    `take-screenshot` block;
 *  - `'element'`  — an img element selected on the page (`selector`), captured
 *    in-page;
 *  - `'page'`     — the previous page snapshot: a capture of the visible page
 *    the run has been driving (default).
 *
 * Output — the recognized string. The output variable NAME is configurable
 * (`variableName`, default `lastOcrText`); its type is always a plain string.
 * Before recognition
 * the image runs through the captcha preprocessing (upscale + contrast
 * stretch) unless `preprocess` is false. The Tesseract language is `lang`
 * (`+`-joined codes), falling back to the global "Local OCR language"
 * setting. An unreadable image or an empty read raises a block error so the
 * engine's onError machinery (retry / fallback / continue) can react — an OCR
 * step that read nothing must not look like success to a downstream fill.
 */
/** Short human preview of a value for log lines (single-line, truncated). */
function logPreview(value: string, max = 120): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/**
 * Best-effort pixel dimensions of an image data URL, for run-log diagnostics.
 * Empty string when the worker cannot decode images (tests, old runtimes).
 */
async function imageDims(dataUrl: string): Promise<string> {
  if (typeof createImageBitmap === 'undefined') return ''
  try {
    const res = await fetch(dataUrl)
    const bitmap = await createImageBitmap(await res.blob())
    const size = `${bitmap.width}×${bitmap.height}`
    bitmap.close()
    return size
  } catch {
    return ''
  }
}

/**
 * Builds the error line for an empty OCR read. Pure so both wordings are unit
 * testable. `hasInk === false` (the capture is a near-uniform box — a canvas
 * captcha or wrapped `<img>` whose pixels never entered the serialization)
 * gets a targeted hint; everything else keeps the generic cause checklist.
 * `null` hasInk (runtime could not decode) also takes the generic path.
 */
export function describeEmptyOcrRead(args: {
  lang: string
  inputDesc: string
  imageChars: number
  inputDims: string
  preprocessUsed: boolean
  preprocessedChars?: number
  confidence: number
  hasInk: boolean | null
}): string {
  const head =
    `ocr: 未识别到文字 (${args.lang}) — ${args.inputDesc}, 图像 ${args.imageChars} 字符` +
    `${args.inputDims ? ` ${args.inputDims}` : ''}` +
    `${args.preprocessUsed ? `, 预处理后 ${args.preprocessedChars ?? ''} 字符` : ''}` +
    `, 置信度 ${Math.round(args.confidence)}`
  if (args.hasInk === false) {
    return (
      head +
      '。截图内容近乎纯色（未包含验证码字形）— canvas 绘制或包着 <img> 的容器不会进入序列化截图，已自动回退像素级截图仍为空；建议把选择器直接指向 <img> 或 <canvas> 元素，或改用「图片变量」输入源'
    )
  }
  return (
    head +
    '。常见原因: 截图区域空白或图片未加载; 预处理把文字洗白（编辑此算子, 关闭"识别前预处理"重试）; 语言不匹配（检查设置里的本地 OCR 语言）'
  )
}

const ocrBlock: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  // The no-ocr release strips the local OCR engine; the block is grayed out in
  // the editor there. A saved/imported workflow can still reference it, so the
  // executor answers with an explicit error instead of a confusing failure.
  if (!OCR_SUPPORTED) {
    throw new Error('ocr: 当前为无 OCR 精简版构建，此算子不可用 — 请安装完整版（含 OCR）')
  }
  const source = String(data['source'] ?? (sel(data) ? 'element' : 'page'))

  let image = ''
  if (source === 'variable') {
    const name = String(data['imageVariable'] ?? 'lastScreenshot')
    const raw = ctx.variables[name]
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (!value) {
      throw new Error(`ocr: 变量 ${name} 为空或不是字符串`)
    }
    // base64 payloads are wrapped so the offscreen canvas can decode them;
    // http(s) links are fetched and re-encoded first (转成图片后识别).
    const normalized = await imageInputToDataUrl(value, ctx.signal)
    if (!normalized) {
      throw new Error(
        `ocr: 变量 ${name} 不是可识别的图片（支持 base64、data URL 或 http(s) 图片链接）`,
      )
    }
    image = normalized
  } else if (source === 'element') {
    const selector = sel(data)
    if (!selector) {
      throw new Error('ocr: 页面 img 元素识别需要 CSS 选择器')
    }
    const captured = await captureElementImage(selector, ctx)
    if (!captured) return null // errors already emitted
    image = captured
  } else {
    const tab = await resolveTargetTab(ctx.tabId, ctx.scope)
    if (!tab || typeof tab.windowId !== 'number') {
      throw new Error('ocr: 没有可截图的活动标签页')
    }
    const capture = await captureVisiblePage(ctx.scope, { format: 'png', tab })
    if (!capture.ok) {
      throw new Error(`ocr: ${capture.error}`)
    }
    image = capture.dataUrl
  }

  // Input diagnostics — the first thing to check when a read comes back empty.
  const inputDesc =
    source === 'variable'
      ? `变量 ${String(data['imageVariable'] ?? 'lastScreenshot')}`
      : source === 'element'
        ? `元素 ${sel(data)}`
        : '整页截图'
  const imageChars = image.length
  const inputDims = await imageDims(image)
  ctx.emit(
    'info',
    `[识别输入] ${inputDesc} · 图像 ${imageChars} 字符${inputDims ? ` (${inputDims})` : ''}`,
  )

  let processed = image
  if (data['preprocess'] !== false) {
    try {
      const before = image
      processed = await preprocessImage(before)
      if (processed !== before) {
        const dims = await imageDims(processed)
        ctx.emit(
          'info',
          `[识别预处理] ${imageChars} 字符 → ${processed.length} 字符${dims ? ` (${dims})` : ''}`,
        )
      }
    } catch {
      processed = image // never block recognition on a convenience step
    }
  }
  const preprocessUsed = processed !== image

  const langParam = interpolate(String(data['lang'] ?? ''), ctx.variables, ctx.refData).trim()
  const lang = langParam || (await getSettings()).ocrLanguage || 'eng'

  const ocr = await ocrImage(processed, lang)
  if (!ocr.ok || !ocr.text.trim()) {
    if (!ocr.ok) throw new Error(`ocr: ${ocr.error}`)
    // Empty read: tell a blank capture (a serialization that lost its content)
    // from a washed-out preprocess from a language mismatch.
    throw new Error(
      describeEmptyOcrRead({
        lang,
        inputDesc,
        imageChars,
        inputDims,
        preprocessUsed,
        preprocessedChars: processed.length,
        confidence: ocr.confidence,
        // Probe the ORIGINAL capture — preprocessing shifts pixels, and the
        // question is whether the capture itself ever contained glyphs.
        hasInk: await imageHasInk(image),
      }),
    )
  }
  const text = ocr.text.trim()

  // Output contract: the recognized string — the variable NAME is editable
  // (`variableName`, default `lastOcrText`), the type is always a string.
  const variable = String(data['variableName'] ?? '').trim() || 'lastOcrText'
  ctx.variables[variable] = text
  ctx.emit('info', `[识别输出] ${variable} = ${logPreview(text, 200) || '(空)'}`)
  ctx.emit('result', `${text.slice(0, 80)} (置信度 ${Math.round(ocr.confidence)})`)
  return null
}

// --- Navigation executors ----------------------------------------------------

const openUrl: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const url = String(data['url'] ?? '')
  if (!isInjectablePage(url)) {
    throw new Error(`仅允许打开 http(s) 页面: ${url}`)
  }
  const tab = await resolveAutomationTab(ctx.tabId, ctx.scope)
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('没有可操作的网页标签页')
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
    const tab = await driverNewTab(url, ctx.scope)
    ctx.setTab?.(tab.id)
    if (url && data['waitTabLoaded'] !== false) {
      await waitForTabLoaded(tab.id, ctx.signal)
    }
    ctx.emit('result', `已新建标签页 #${tab.id}`)
  } catch (error) {
    throw error
  }
  return null
}

/**
 * Match a tab URL against an Automa-style match pattern (`https://*.example.com/*`).
 * Only `*` is special — everything else is escaped, so a pattern containing
 * regex metacharacters matches them literally.
 */
function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  try {
    return new RegExp(`^${escaped.split('*').join('.*')}$`).test(value)
  } catch {
    return false
  }
}

const switchTabExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  try {
    // `listAllTabUrls` does not promise an order; `tabIndex` means "the Nth
    // tab", which is the driver's own `listTabs` order (ascending id).
    const tabs = (await listAllTabUrls(ctx.scope)).sort((a, b) => a.id - b.id)
    if (tabs.length === 0) {
      throw new Error('switch-tab: 当前窗口没有可切换的标签页')
    }
    // `findTabBy` / `matchPattern` / `tabTitle` / `tabIndex` / `createIfNoMatch`
    // / `activeTab` are all catalog + edit-form keys. Only `index` used to be
    // read, and nothing ever wrote it — so `Number(undefined ?? 0)` made every
    // switch land on tab 0 regardless of what the user configured.
    const findBy = String(data['findTabBy'] ?? 'tab-index')
    const pattern = interpolate(String(data['matchPattern'] ?? ''), ctx.variables, ctx.refData)
    const title = interpolate(String(data['tabTitle'] ?? ''), ctx.variables, ctx.refData)
    // "Next" / "previous" are relative to the tab the run is driving.
    const current = (await resolveTargetTab(ctx.tabId, ctx.scope))?.id

    let index = -1
    if (findBy === 'match-patterns' && pattern) {
      index = tabs.findIndex((tab) => globMatch(pattern, tab.url))
    } else if (findBy === 'tab-title' && title) {
      index = tabs.findIndex((tab) => tab.title.includes(title))
    } else if (findBy === 'next-tab' || findBy === 'prev-tab') {
      const at = tabs.findIndex((tab) => tab.id === current)
      const step = findBy === 'next-tab' ? 1 : -1
      index = at < 0 ? 0 : (at + step + tabs.length) % tabs.length
    } else {
      const wanted = Number(data['tabIndex'] ?? data['index'] ?? 0)
      index = Number.isFinite(wanted) ? Math.trunc(wanted) : 0
      if (index < 0 || index >= tabs.length) {
        throw new Error(
          `switch-tab: 标签页索引 ${index} 超出范围（本窗口共 ${tabs.length} 个），无法切换`,
        )
      }
    }

    if (index < 0) {
      const createUrl = interpolate(String(data['url'] ?? ''), ctx.variables, ctx.refData)
      if (data['createIfNoMatch'] === true && createUrl) {
        const tab = await driverNewTab(createUrl, ctx.scope)
        ctx.setTab?.(tab.id)
        ctx.emit('result', `没有匹配的标签页，已新建 #${tab.id}`)
        return null
      }
      throw new Error(`switch-tab: 没有匹配的标签页（findTabBy=${findBy}）`)
    }

    const target = tabs[index]!
    // "Set as active tab" is what the checkbox means. Unchecking it still
    // retargets the run at that tab, it just does not steal the user's focus.
    if (data['activeTab'] !== false) await chrome.tabs.update(target.id, { active: true })
    ctx.setTab?.(target.id)
    ctx.emit('result', `已切换到标签页 #${target.id} ${target.title.slice(0, 40)}`)
  } catch (error) {
    throw error
  }
  return null
}

const closeTabExec: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  try {
    await closeActiveTab(ctx.scope)
    ctx.emit('result', '已关闭当前标签页')
  } catch (error) {
    throw error
  }
  return null
}

const reloadTabExec: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  // Reload the tab the RUN is driving, not whichever tab happens to be active.
  const tab = await resolveTargetTab(ctx.tabId, ctx.scope)
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('没有活动标签页')
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
  ctx.emit('result', `已设置变量 ${name} = ${logPreview(value) || '(空)'}`)
  return null
}

/**
 * `get-secret` block: fetch a stored credential field at runtime and store its
 * value in a variable. The secret value is never embedded in the workflow — it
 * is resolved fresh each run, so credential updates are picked up automatically.
 *
 * Both fields are REQUIRED — no silent defaults. A workflow auto-generated from
 * incomplete history (no `id`, no field) MUST surface that here instead of
 * falling back to `lastSecret`, otherwise downstream `{{lastSecret}}` literals
 * end up in form inputs.
 */
const getSecret: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const variableName = String(data['variableName'] ?? '').trim()

  // The form encodes the user's pick as "<secretId>::<fieldKey>". A workflow
  // generated before the dropdown refactor may still carry separate
  // `secretId` + `fieldName` fields; fall back to that shape so older saved
  // workflows keep running.
  let credential = String(data['credential'] ?? '')
  if (!credential) {
    const legacyId = String(data['secretId'] ?? '')
    const legacyField = String(data['fieldName'] ?? '')
    if (legacyId) credential = legacyField ? `${legacyId}::${legacyField}` : legacyId
  }
  const sepIdx = credential.indexOf('::')
  const secretId = sepIdx >= 0 ? credential.slice(0, sepIdx) : credential
  const fieldName = sepIdx >= 0 ? credential.slice(sepIdx + 2) : ''

  if (!secretId) {
    throw new Error('get-secret: 未指定凭证 ID')
  }
  if (!variableName) {
    throw new Error('get-secret: 未指定输出变量名')
  }

  let value = ''
  // Every failure below throws rather than logging: the block's output is the
  // credential, and writing `''` into `variableName` made a downstream
  // `{{secret}}` resolve to an empty string — the step "succeeded" with a blank
  // password.
  try {
    const entries = await listPasswords()
    const entry = entries.find((e) => e.id === secretId)
    if (!entry) {
      throw new Error(`get-secret: 未找到 ID 为 "${secretId}" 的凭证`)
    }
    const field =
      (fieldName && findField(entry, fieldName)) ??
      findField(entry, 'password') ??
      entryFields(entry)[0]
    if (!field) {
      throw new Error(`get-secret: 凭证中未找到字段 "${fieldName}"`)
    }
    value = field.value
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('get-secret:')) throw err
    throw new Error(
      `get-secret: 读取凭证失败 — ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  ctx.variables[variableName] = value
  ctx.emit(
    'result',
    `已获取凭证字段 "${fieldName || 'password'}" → 变量 ${variableName} (值已隐藏)`,
  )
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
  // `dataList` is the catalog + tool-schema key (a real array); `data` is the
  // JSON-string shape this executor used to read alone. Accepting both is what
  // makes a generated node and a canvas node agree.
  const rawList = data['dataList'] ?? data['data']
  let items: unknown[] = []
  if (Array.isArray(rawList)) {
    items = rawList
  } else if (typeof rawList === 'string' && rawList.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(rawList)
      if (Array.isArray(parsed)) items = parsed
    } catch {
      /* malformed json → insert nothing */
    }
  }
  if (!Array.isArray(ctx.variables['dataTable'])) ctx.variables['dataTable'] = []
  const table = ctx.variables['dataTable'] as unknown[]
  table.push(...items)
  ctx.emit('result', `已插入 ${items.length} 行`)
  return null
}

/** Decode base64 into bytes, for the binary (screenshot) write paths. */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  // Backed by a real ArrayBuffer (not ArrayBufferLike) so the result satisfies
  // `BufferSource` for `createWritable().write`.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Strip a `data:<mime>;base64,` prefix, leaving the payload alone. */
function base64Body(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
}

/**
 * Write a file, preferring the download directory configured in settings and
 * falling back to the side panel's save picker.
 *
 * Shared by `save-local`, `export-data` and `take-screenshot`. It used to be
 * inlined in `save-local` only, and `export-data` — whose catalog description
 * reads "Write collected data out to a file" — wrote nothing to disk at all,
 * just a variable. Three callers, one implementation, so they cannot drift
 * again on the questions that matter: does a configured directory win, what
 * happens when the write fails, and what the user is told either way.
 *
 * A configured download directory wins unconditionally, deliberately: the user
 * set it up precisely so that saving stops asking. That does mean `save-local`'s
 * `saveMode: 'manual'` cannot override it — preserved as-is rather than "fixed",
 * because the opposite change would start prompting everyone who configured a
 * directory. (`resolveTransferMode` in `lib/download-dir` encodes the stricter
 * reading and is what the chat agent's own `save_local` tool consults.)
 *
 * @returns `'saved'` once a file exists, `'canceled'` when the user dismissed
 *   the picker, `'failed'` when nothing could be written.
 */
async function writeToConfiguredDir(
  filename: string,
  payload: SavePickerPayload,
  ctx: WorkflowExecCtx,
): Promise<'saved' | 'canceled' | 'failed'> {
  const dir = await getDownloadDir()
  if (dir) {
    // Trust the actual write attempt rather than `dir.queryPermission` — in a
    // service worker that call can throw or report "denied" even when the
    // persisted handle is still usable (e.g. after a worker/extension restart),
    // which would push every run into the manual confirmation branch.
    const data = payload.base64 === undefined ? (payload.text ?? '') : base64ToBytes(payload.base64)
    if (await writeFileToDownloadDir(dir, filename, data)) {
      ctx.emit('result', `已自动保存: ${filename}`)
      return 'saved'
    }
    // Handle lost its permission, directory removed, …: go to the picker rather
    // than re-attempting the same write.
    ctx.emit('info', '写入配置目录失败，改为询问保存位置')
  }

  const res = await askSaveViaSidePanel(filename, payload)
  if (res.canceled) {
    ctx.emit('result', '用户取消了保存')
    return 'canceled'
  }
  if (res.ok) {
    ctx.emit('result', `已通过另存为保存: ${filename}`)
    return 'saved'
  }
  ctx.emit('error', '无法弹出保存对话框：请打开侧面板后重试')
  return 'failed'
}

/**
 * Write a file a block produced, failing the step when it could not be written.
 *
 * Every caller used to ignore a `'failed'` outcome, so a node whose entire
 * purpose is the file still reported success with nothing on disk — the same
 * shape as the empty-read bug. `'canceled'` is the user's own choice and stays a
 * non-error, but the caller must not then claim the file exists.
 */
async function writeProducedFile(
  what: string,
  filename: string,
  payload: SavePickerPayload,
  ctx: WorkflowExecCtx,
): Promise<'saved' | 'canceled'> {
  const outcome = await writeToConfiguredDir(filename, payload, ctx)
  if (outcome === 'failed') {
    throw new Error(`${what}: 写入 ${filename} 失败——无法打开保存对话框，请打开侧面板后重试。`)
  }
  return outcome
}

/**
 * Render a collected table as the text the exported file will hold.
 *
 * `csv` quotes only the cells that need it and keeps the header; `plain-text`
 * is the same rows without the header and without quoting. The two differ in
 * exactly the ways someone choosing "CSV" over "Plain text" expects, which is
 * the point: the form offers both, so both have to mean something.
 */
function renderTable(
  table: Record<string, unknown>[],
  format: string,
  delimiter: string,
  bom: boolean,
): string {
  if (format === 'json') return JSON.stringify(table)
  if (table.length === 0) return ''
  const header = Object.keys(table[0] as Record<string, unknown>)
  if (format === 'plain-text') {
    return table
      .map((row) => header.map((key) => String(row[key] ?? '')).join(delimiter))
      .join('\n')
  }
  const cell = (value: unknown): string => {
    const raw = String(value ?? '')
    const needsQuotes = raw.includes(delimiter) || /["\n\r]/.test(raw)
    return needsQuotes ? `"${raw.replace(/"/g, '""')}"` : raw
  }
  const body = [header, ...table.map((row) => header.map((key) => cell(row[key])))]
    .map((row) => row.join(delimiter))
    .join('\n')
  // Excel reads a UTF-8 CSV as the local codepage unless a BOM says otherwise,
  // which turns every Chinese cell into mojibake. Off unless asked for, so the
  // bytes of an existing workflow's export do not change under it.
  return bom ? `\uFEFF${body}` : body
}

const exportData: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)

  // `type` / `name` are the keys the catalog declares, `EditExportData` edits and
  // `operator-guide` tells the model to send (`export-data(name:'x.csv',
  // type:'csv')`). `format` / `filename` are the names this executor used to
  // read, kept as fallbacks so a workflow saved before the four agreed still
  // names its file. Reading only the latter is how every field a user can set
  // became inert: the file was always `export.csv` and "Export as JSON" always
  // wrote CSV.
  const format = String(data['type'] ?? data['format'] ?? 'csv')
  const delimiter = String(data['csvDelimiter'] ?? '') || ','
  const mode = String(data['dataToExport'] ?? 'data-columns')

  if (mode === 'google-sheets') {
    // Cloud block: no OAuth credentials are wired up here, so say that rather
    // than write a local file under a Google label.
    throw new Error('export-data: Google Sheets 导出需要 OAuth 凭据，尚未配置')
  }

  let table: Record<string, unknown>[] = []
  let text = ''

  if (mode === 'variable') {
    const variable = String(data['variableName'] ?? '').trim()
    if (!variable) {
      throw new Error('export-data: 导出目标是「变量」但没有填 variableName，无法导出')
    }
    const value = ctx.variables[variable]
    if (value === undefined) {
      // Naming the variable is the whole diagnosis: either the producing step
      // never ran or it writes under a different name.
      throw new Error(`export-data: 变量 ${variable} 还没有值，无法导出`)
    }
    text = format === 'json' ? JSON.stringify(value) : String(value)
  } else {
    table = Array.isArray(ctx.variables['dataTable'])
      ? (ctx.variables['dataTable'] as Record<string, unknown>[])
      : Array.isArray(ctx.refData)
        ? (ctx.refData as Record<string, unknown>[])
        : []
    // An empty table is the single most common "工作流跑完了但文件是空的"
    // report, and it is never what the user wanted. It used to be written out
    // silently (with an `info` line at most), which is indistinguishable from a
    // successful export — so refuse, and name every way it happens.
    if (table.length === 0) {
      throw new Error(
        'export-data: 数据表是空的，没有内容可导出。' +
          '数据表只由**读取节点**填充，请检查：' +
          '① 读取步骤是否设了 saveData:true 并填了 dataColumn（列名）；' +
          '② 读取步骤的选择器是否真的匹配到了元素（匹配不到会直接报错，不会再静默导出空文件）；' +
          '③ 读取步骤是否排在导出之前。' +
          '整张表导出请用 get-text(multiple:true) 采集，save-local 只适合单个值。',
      )
    }
    text = renderTable(table, format, delimiter, data['addBOMHeader'] === true)
  }

  // Kept for downstream `{{lastExport}}` references: a workflow may export once
  // and then send the same text to a webhook.
  ctx.variables['lastExport'] = text

  // The block's whole point is the FILE.
  const rawName = interpolate(
    String(data['name'] ?? data['filename'] ?? ''),
    ctx.variables,
    ctx.refData,
  )
  const fallbackExtension = format === 'json' ? 'json' : format === 'plain-text' ? 'txt' : 'csv'
  const filename = rawName.trim() || `export.${fallbackExtension}`
  const outcome = await writeProducedFile('export-data', filename, { text }, ctx)
  if (outcome === 'saved') {
    // Downstream steps can reference where it landed; `lastExport` keeps the
    // contents, so the two names cannot be confused for one another.
    ctx.variables['lastExportPath'] = filename
    ctx.emit('info', `已导出 ${table.length || 1} 行到 ${filename}`)
  }
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
  // `time` is the catalog + edit-form key; `ms` kept for legacy graphs.
  const raw = data['time'] ?? data['ms']
  const ms = raw === undefined || raw === null || raw === '' ? 500 : Number(raw)
  await sleep(Number.isFinite(ms) ? ms : 500, ctx.signal)
  ctx.emit('status', `延时 ${ms}ms`)
  return null
}

const breakpoint: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  ctx.emit('info', '断点：执行暂停在此处')
  return null
}

/** Parse a response body according to the block's `responseType`. */
function parseResponseBody(text: string, responseType: string): unknown {
  if (responseType !== 'json') return text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Narrow a parsed body to the block's `dataPath` (`data.items.0.id`). */
function pickDataPath(value: unknown, path: string): unknown {
  const segments = path.split('.').filter((segment) => segment.trim() !== '')
  if (segments.length === 0) return value
  return getByPath(value, segments.join('.'))
}

/** Base64 of a response body, for `responseType: 'base64'`. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Default request `content-type` per the form's "Content type" select. The
 * header used to be hardcoded to JSON, so the select did nothing.
 */
const WEBHOOK_CONTENT_TYPES: Readonly<Record<string, string>> = {
  json: 'application/json',
  text: 'text/plain',
  'form-data': 'multipart/form-data',
  form: 'application/x-www-form-urlencoded',
}

const webhook: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const url = interpolate(String(data['url'] ?? ''), ctx.variables, ctx.refData)
  const method = String(data['method'] ?? 'POST').toUpperCase()
  const timeout = Math.max(0, Number(data['timeout'] ?? 30000))
  // `variableName` is the catalog + edit-form key (the "Assign response to a
  // variable" field); `responseVariable` is the legacy name. Reading only the
  // latter meant a user- or model-chosen name never existed, so every
  // downstream `{{thatName}}` reference dangled and resolved to nothing.
  const responseVariable = String(
    data['variableName'] || data['responseVariable'] || 'lastHttpResponse',
  )
  // `responseType` decides how the body is decoded and `dataPath` narrows it.
  // Both are edit-form fields that nothing used to read.
  const responseType = String(data['responseType'] ?? 'json')
  const dataPath = String(data['dataPath'] ?? '')

  // Headers: interpolated JSON string, e.g. `{"Authorization":"Bearer ..."}`.
  // The default content type comes from the form's own select.
  let headers: Record<string, string> = {
    'content-type':
      WEBHOOK_CONTENT_TYPES[String(data['contentType'] ?? 'json')] ?? 'application/json',
  }
  const headersRaw = interpolate(String(data['headers'] ?? ''), ctx.variables, ctx.refData)
  if (headersRaw.trim()) {
    try {
      const parsed = JSON.parse(headersRaw)
      if (parsed && typeof parsed === 'object')
        headers = { ...headers, ...parsed } as Record<string, string>
    } catch {
      throw new Error(
        `webhook: headers 不是合法 JSON，请求头无法确定，已中止本次请求。收到的值：${headersRaw.slice(0, 120)}`,
      )
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
      const responseText =
        responseType === 'base64' ? toBase64(await response.arrayBuffer()) : await response.text()
      const record = {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseText,
        // The decoded body, narrowed by `dataPath` when one is set. Additive on
        // purpose: `{{var.body}}` keeps working exactly as before, and `{{var}}`
        // was already `[object Object]`, so nothing that worked stops working.
        data: pickDataPath(parseResponseBody(responseText, responseType), dataPath),
      }
      ctx.variables[responseVariable] = record
      ctx.emit('result', `${method} ${response.status} ${responseText.slice(0, 80)}`)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  } catch (error) {
    // A request that never completed is a failed step, not a note in the log.
    // `AbortError` needs care here: this block aborts its own fetch on timeout,
    // and the engine reads `AbortError` as "the user cancelled the run" — so a
    // timeout is translated into a plain failure, while a genuine cancellation
    // keeps propagating and the run still reports 已取消.
    if ((error as Error)?.name === 'AbortError') {
      if (ctx.signal.aborted) throw error
      throw new Error(`${method} 请求超时（${timeout}ms）：${url}`)
    }
    throw error
  }
  return null
}

const notification: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const title = interpolate(String(data['title'] ?? '通知'), ctx.variables, ctx.refData)
  const body = interpolate(String(data['message'] ?? ''), ctx.variables, ctx.refData)
  const api = typeof chrome !== 'undefined' ? chrome.notifications : undefined
  if (api) {
    // No catch on purpose: a notification that could not be shown is a failed
    // step, and `emit('error')` alone would still let the run report success.
    await api.create({ type: 'basic', iconUrl: 'icons/icon-48.png', title, message: body })
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
    throw new Error('javascript-code: 代码为空')
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
      run = await execWorkflowJsOnActiveTab(
        code,
        ctx.variables,
        timeout,
        ctx.signal,
        ctx.tabId,
        ctx.scope,
      )
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
    // A failure envelope returned to the page harness is a node failure: the
    // script ran but reported it did not reach its target.
    const pageVerdict = interpretScriptResult(result)
    if (!pageVerdict.ok) {
      throw new Error(`javascript-code: ${pageVerdict.reason}`)
    }
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
    // Thrown: a code node that did not run leaves every variable it was supposed
    // to produce unset, and the rest of the workflow then runs on stale data.
    throw new Error(`javascript-code: ${triedPage && run && !run.ok ? run.error : local.error}`)
  }
  for (const [k, v] of Object.entries(local.variables ?? {})) ctx.variables[k] = v
  ctx.variables['lastResult'] = local.result
  // A returned failure envelope is a failed node even off-page.
  const envelopeVerdict = interpretScriptResult(local.result)
  if (!envelopeVerdict.ok) {
    throw new Error(`javascript-code: ${envelopeVerdict.reason}`)
  }
  if (local.result !== undefined) {
    ctx.emit(
      'result',
      typeof local.result === 'string' ? local.result : safeStringify(local.result),
    )
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
        /* local eval runs to completion; timeout is a page-harness concern */
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
 * a plain typo. If the local (worker / Node) fallback meets a ReferenceError on
 * one of these, the page bridge failed to run first and the code cannot work here.
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
    return `${raw}。这段代码引用了只在网页中存在的全局「${name}」，无法在后台线程运行；当前未能注入页面（未找到可操作的 http(s) 页面，或页面禁止脚本注入），因此回退到本地求值失败。请先在普通 http(s) 网页上运行，或把该步骤改成浏览器操作块。`
  }
  return raw
}

const aiPrompt: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const prompt = interpolate(String(data['prompt'] ?? ''), ctx.variables, ctx.refData)
  const settings = await getSettings()
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId)
  if (!provider || !provider.apiKey.trim()) {
    // Fail the block (engine onError: retry → fallback → stop) — never
    // continue without a model, downstream would act on an empty variable.
    throw new Error('AI 块: 未配置模型给 provider')
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
    // `lastAIResponse` is consumed verbatim by later steps (`{{lastAIResponse}}`
    // fills, conditions, code): strip reasoning-model `<think>` blocks and a
    // wrapping ``` fence so wrapper junk never reaches downstream variables.
    const clean = sanitizeModelAnswer(result.content)
    ctx.variables['lastAIResponse'] = clean
    ctx.emit('result', clean)
  } catch (error) {
    // No answer → FAIL the block (engine onError: retry → fallback → stop).
    // The old emit-and-continue let downstream run on a stale/empty
    // lastAIResponse, which read as "the workflow didn't wait for the AI".
    ctx.variables['lastAIResponse'] = ''
    throw new Error(`AI 块: ${message(error)}`)
  }
  return null
}

/** Launch triggers act as pass-through entry points in the browser build. */
const noop: BlockExecutor = async () => Promise.resolve(null)

// --- Phase 2: browser actions ----------------------------------------------

const cookieBlock: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  // `op` is the key the operator tool schema teaches; the edit form writes the
  // drifted `type` plus a separate `getAll` flag — both kept as fallbacks.
  const rawOp = String(data['op'] ?? data['type'] ?? 'get')
  const op = rawOp === 'get' && data['getAll'] === true ? 'getAll' : rawOp
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
        throw new Error('cookie: 写入需要 URL')
      }
      const expiry = Number(data['expirationDate'] ?? 0)
      await cookieSet(name, value, url, expiry > 0 ? { expirationDate: expiry } : {})
      ctx.emit('result', `已写入 ${name}`)
    } else if (op === 'remove') {
      if (!url) {
        throw new Error('cookie: 删除需要 URL')
      }
      await cookieRemove(name, url)
      ctx.emit('result', `已删除 ${name}`)
    } else {
      throw new Error(`cookie: 不支持的操作 ${op}`)
    }
  } catch (error) {
    throw error
  }
  return null
}

const clipboardBlock: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  // `op` / `text` are the keys the operator tool schema teaches; the edit form
  // writes the drifted `type` (`get` / `insert`) + `dataToCopy` — kept as
  // fallbacks so canvas-authored nodes keep working.
  const rawOp = String(data['op'] ?? data['type'] ?? 'get')
  const op = rawOp === 'insert' || rawOp === 'set' ? 'set' : 'get'
  try {
    if (op === 'get') {
      const text = await clipboardGet()
      ctx.variables[String(data['variableName'] ?? 'lastClipboard')] = text
      ctx.emit('result', text.slice(0, 80))
    } else {
      const text = interpolate(
        String(data['text'] ?? data['dataToCopy'] ?? ''),
        ctx.variables,
        ctx.refData,
      )
      await clipboardInsert(text)
      ctx.emit('result', '已写入剪贴板')
    }
  } catch (error) {
    throw new Error(`剪贴板 ${op} 失败: ${message(error)}`)
  }
  return null
}

const elementExistsExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const count = await elementExists(sel(data), ctx.signal, ctx.scope)
  const exists = count > 0
  ctx.emit('result', exists ? `元素存在 (${count})` : '元素不存在')
  return exists
    ? (ctx.outputs?.['exists'] ?? ctx.defaultNext ?? null)
    : (ctx.outputs?.['notExists'] ?? ctx.defaultNext ?? null)
}

const linkBlock: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const selector = sel(data)
  // `newTab` is the key the tool schema teaches; `openInNewTab` is the edit
  // form's drifted name — kept as a fallback.
  const newTab =
    (data['newTab'] as boolean | undefined) ?? (data['openInNewTab'] as boolean | undefined) ?? true
  try {
    const result = await execOnActiveTab(
      { action: 'click_link', target: cssTarget(selector) },
      ctx.signal,
      ctx.tabId,
      ctx.scope,
    )
    const info = result.data as { href?: string; target?: string } | undefined
    const href = info?.href ?? result.note ?? ''
    const waitLoaded = data['waitTabLoaded'] !== false
    if (newTab && info?.target === '_self') {
      if (href) {
        const tab = await driverNewTab(href, ctx.scope)
        ctx.setTab?.(tab.id)
        if (waitLoaded) await waitForTabLoaded(tab.id, ctx.signal)
      }
      ctx.emit('result', `已在新标签页打开 ${href}`)
    } else {
      await execOnActiveTab(
        withWait({ action: 'click', target: cssTarget(selector) }, data),
        ctx.signal,
        ctx.tabId,
        ctx.scope,
      )
      if (waitLoaded) {
        const tab = await resolveTargetTab(ctx.tabId, ctx.scope).catch(() => null)
        if (tab && typeof tab.id === 'number') await waitForTabLoaded(tab.id, ctx.signal)
      }
      ctx.emit('result', '已点击链接')
    }
  } catch (error) {
    throw error
  }
  return null
}

const attributeValueExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  // `op` / `attribute` / `value` are the keys the operator tool schema teaches;
  // `action` / `attributeName` / `attributeValue` are the edit form's drifted
  // names — kept as fallbacks so canvas-authored nodes keep working.
  const op = String(data['op'] ?? data['action'] ?? 'get')
  const attribute = String(data['attribute'] ?? data['attributeName'] ?? '')
  const variable = String(data['variableName'] ?? 'lastAttribute')
  const opData: Op = {
    action: op === 'set' ? 'set_attribute' : 'get_attribute',
    target: targetFrom(data),
    attribute,
  }
  // Reads must not race a just-navigated page either: the kernel polls the
  // target's existence for `op.waitFor` ms before acting, same contract as the
  // direct-injection reads above.
  const waitMs = readWaitMsOf(data)
  if (waitMs > 0) opData.waitFor = waitMs
  if (op === 'set') {
    opData.value = interpolate(
      String(data['value'] ?? data['attributeValue'] ?? ''),
      ctx.variables,
      ctx.refData,
    )
  }
  const result = await execOnActiveTab(opData, ctx.signal, ctx.tabId, ctx.scope)
  if (op === 'get') {
    const value = result.data ?? result.note ?? ''
    // Same rule as `get-text`: an attribute read that yields nothing (element
    // not matched, attribute absent, or the driver reported a note instead of a
    // value) must fail rather than write an empty string that a downstream
    // export turns into a blank file.
    requireReadMatch(`attribute-value(attribute: "${attribute || '(未指定)'}")`, [
      typeof value === 'string' ? value : JSON.stringify(value ?? ''),
    ])
    ctx.variables[variable] = value
    ctx.emit('result', String(value))
  } else {
    ctx.emit('result', `已设置属性 ${attribute}`)
  }
  return null
}

const goBackExec: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  try {
    await goBack(ctx.scope)
    ctx.emit('result', '已后退')
  } catch (error) {
    throw error
  }
  return null
}

const forwardPage: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  try {
    await goForward(ctx.scope)
    ctx.emit('result', '已前进')
  } catch (error) {
    throw error
  }
  return null
}

const tabUrlExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const variable = String(data['variableName'] ?? 'lastTabUrl')
  // `scope` is the tool-schema key; `type` is the edit form's drifted name.
  const scope = String(data['scope'] ?? data['type'] ?? 'active-tab')
  try {
    const current =
      scope === 'all' ? await listAllTabUrls(ctx.scope) : await getActiveTabInfo(ctx.scope)
    ctx.variables[variable] = current
    ctx.emit('result', Array.isArray(current) ? `共 ${current.length} 个标签页` : current.url)
  } catch (error) {
    throw error
  }
  return null
}

const activeTabExec: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const variable = String(data['variableName'] ?? 'lastActiveTab')
  try {
    const info = await getActiveTabInfo(ctx.scope)
    ctx.variables[variable] = info
    ctx.emit('result', `${info.title} · ${info.url}`)
  } catch (error) {
    throw error
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
    throw error
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
    await execOnActiveTab(opData, ctx.signal, ctx.tabId, ctx.scope)
    ctx.emit('result', '已设置文件输入')
  } catch (error) {
    throw error
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
  if (!name) {
    throw new Error('increase-variable: 缺少 variableName，无法执行')
  }
  // `increaseBy` is the catalog + edit-form key; `value` is the legacy name.
  const step = Number(
    interpolate(String(data['increaseBy'] ?? data['value'] ?? '1'), ctx.variables, ctx.refData),
  )
  // The current value must actually be read. This used to be
  // `Number((vars[name] ?? incType === 'multiply') ? 1 : 0)`, which parses as
  // `vars[name] ?? (incType === 'multiply')` — `??` binds looser than `===` —
  // so any existing value collapsed to 1 and `counter = 5` + 1 became 2.
  const current = Number(ctx.variables[name] ?? 0)
  const next = data['incType'] === 'multiply' ? current * step : current + step
  ctx.variables[name] = Number.isNaN(next) ? 0 : next
  ctx.emit('result', `${name} = ${ctx.variables[name]}`)
  return null
}

const sliceVariable: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const name = String(data['variableName'] ?? '')
  if (!name) {
    throw new Error('slice-variable: 缺少 variableName，无法执行')
  }
  // `startIndex` / `endIndex` (+ their `…IdxEnabled` toggles) are the catalog
  // and edit-form keys; `start` / `end` are the legacy names. A legacy graph
  // carries `end` with no toggle at all, and there the presence of `end` is
  // itself the "use it" signal — otherwise it would silently slice to the end.
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
  else {
    // Slicing a missing or non-sliceable value silently produced `undefined`,
    // which downstream blocks then interpolate as an empty string.
    throw new Error(`slice-variable: 变量 ${name} 不存在或不是字符串/数组，无法执行`)
  }
  ctx.variables[String(data['output'] ?? name)] = sliced
  ctx.emit('result', String(sliced ?? ''))
  return null
}

const regexVariable: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const name = String(data['variableName'] ?? '')
  if (!name) {
    throw new Error('regex-variable: 缺少 variableName，无法执行')
  }
  // `expression` is the catalog + edit-form key (the field is literally called
  // "Expression"); `pattern` is the legacy name. `flag` is an ARRAY in the
  // catalog (the form renders checkboxes), so it has to be joined — reading it
  // as a string produced `[object Array]` and `new RegExp` threw.
  const pattern = String(data['expression'] ?? data['pattern'] ?? '')
  const rawFlag = data['flag'] ?? data['flags'] ?? 'g'
  const flags = Array.isArray(rawFlag) ? rawFlag.join('') : String(rawFlag)
  const replace = interpolate(
    String(data['replaceVal'] ?? data['replace'] ?? ''),
    ctx.variables,
    ctx.refData,
  )
  const operation = String(data['method'] ?? data['operation'] ?? 'match')
  const value = String(ctx.variables[name] ?? '')
  if (!pattern) {
    throw new Error('regex-variable: 正则表达式为空，无法执行')
  }
  try {
    const regex = new RegExp(pattern, flags)
    let result: string
    if (operation === 'replace') result = value.replace(regex, replace)
    else {
      // `String.match` returns every hit only when the regex carries `g`;
      // without it the result is a single match (length 1, plus `index`/`input`
      // as non-enumerable properties). The old code stripped `g` before
      // matching and then expected the global result, so "match all" could
      // never return more than one hit.
      const found = value.match(new RegExp(pattern, flags)) ?? []
      result = JSON.stringify(found.map((m) => String(m)))
    }
    ctx.variables[String(data['output'] ?? name)] = result
    ctx.emit('result', result.slice(0, 80))
  } catch (error) {
    // A bad pattern leaves the variable unwritten, so downstream steps read a
    // stale value — that is a failed step, not a log line.
    throw new Error(`regex-variable: 正则表达式无效（${pattern}）：${message(error)}`)
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
  const rows = tableOf(ctx).filter(
    (row): row is Record<string, unknown> => !!row && typeof row === 'object',
  )
  const expression = String(data['mapping'] ?? 'item')
  // Map every row in ONE page injection (rather than one eval per row). The
  // expression is evaluated with `item`, `index`, and `vars` in scope.
  const wrapped = `return rows.map((item, index) => (${expression}));`
  const evaluated = await evalInPage(wrapped, { rows, vars: ctx.variables }, ctx)
  if (!evaluated.ok) {
    throw new Error('data-mapping: 映射表达式执行失败')
  }
  const mapped = Array.isArray(evaluated.value) ? evaluated.value : []
  // `output` is the executor's own key; `variableName` is what the catalog and
  // the tool schema declare — accept both so the model's chosen name wins.
  ctx.variables[String(data['output'] ?? data['variableName'] ?? 'mappedData')] = mapped
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

/**
 * Resolve a block's DECLARED inputs into the run's variable scope.
 *
 * This block used to read `prompt` / `defaultValue` / `variableName`, which no
 * version of the catalog or the editor ever wrote — its real shape is a
 * `parameters` list (`WorkflowParameter[]`), the same one the trigger carries.
 * Reading the wrong keys made the block a no-op that emitted an empty string,
 * so a workflow relying on it typed a blank field.
 *
 * There is no interactive prompt in this build: values come from the scope,
 * which the run path seeds from the workflow's declared inputs (trigger
 * parameters) and which earlier steps fill. A declared input that is still
 * missing therefore FAILS when marked required, rather than silently passing
 * `''` to the rest of the graph.
 */
const parameterPrompt: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const parameters = workflowParametersOf(data['parameters'])
  if (parameters.length === 0) {
    ctx.emit('info', '参数输入：未声明任何参数')
    return null
  }

  // A default only fills a gap: a value the scope already holds came from a
  // trigger payload or an earlier step and is the more specific answer.
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
    // Throwing (not returning) is how a block fails: the return value picks the
    // next output port, and silently taking the default one would drive the
    // page with a blank value the user never supplied.
    ctx.emit('error', `缺少必填输入：${missing.join('、')}`)
    throw new Error(`Missing required workflow input(s): ${missing.join(', ')}`)
  }

  const resolved = parameters.map(
    (param) => `${param.name}=${String(ctx.variables[param.name] ?? '')}`,
  )
  ctx.emit('result', resolved.join(' · '))
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
  // `event` / `detail` are the keys the operator tool schema teaches (and the
  // kernel reads); `eventName` / `eventType` are the catalog's drifted names —
  // kept as fallbacks so editor-built nodes keep dispatching.
  const event = String(data['event'] ?? data['eventName'] ?? '')
  const detail = interpolate(String(data['detail'] ?? 'null'), ctx.variables, ctx.refData)
  return runRaw(
    { action: 'trigger_event', target: targetFrom(data), attribute: event, value: detail },
    ctx,
  )
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
    const match = filename ? items.find((item) => item.filename.includes(filename)) : items[0]
    ctx.variables[variable] = match
      ? { id: match.id, filename: match.filename, url: match.url }
      : null
    ctx.emit('result', match ? `最近下载: ${match.filename}` : '未找到匹配下载')
  } catch (error) {
    throw error
  }
  return null
}

const saveAssetsExec: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  ctx.emit('info', 'save-assets: 资源保存需工作区目标，当前为占位实现')
  return null
}

const saveLocal: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  const raw = String(data['value'] ?? '')
  const value = interpolate(raw, ctx.variables, ctx.refData)
  // 空串也要回退到默认名（`data['filename'] ?? ...` 挡不住 `''`，那会让自动保存
  // 因非法文件名静默失败）。
  const filename = interpolate(String(data['filename'] || 'file.txt'), ctx.variables, ctx.refData)
  const variable = String(data['variableName'] ?? 'lastSavedPath')

  // 一个 0 字节文件**看起来和成功一模一样**，却会覆盖上一次导出的好数据 ——
  // 这是最坏的一种静默失败：用户只知道"文件是空的"，无从知道为什么。
  // 两种成因都要点名，因为修法完全不同：
  //  1. `value` 压根没传 —— 生成时最常见的错误是把 `variableName` 当成
  //     "要保存的那个变量"（它是**输出**：保存后回填路径用的）。此时整个节点
  //     只剩文件名，写出来必然是空的。
  //  2. `value` 是 `{{引用}}`，但它引用的东西没产出 —— 引擎会把参数名记进
  //     `EMPTY_INTERP_KEY`，这是"引用为空"与"故意写空"的唯一区分方式。
  const flaggedEmpty = (data[EMPTY_INTERP_KEY] as string[] | undefined)?.includes('value') === true
  if (value.trim() === '') {
    const missing = data['value'] === undefined
    // Thrown, not logged: `emit('error')` still let the run report success and
    // still let the operator bridge record the node, which is how a generated
    // workflow ended up with a save step that writes nothing.
    throw new Error(
      missing
        ? `save-local: 没有内容可写 —— 缺少 value 参数，未写入 ${filename}。` +
            '注意 variableName 是「保存后回填路径的变量名」，不是内容来源；' +
            '内容要写成 value: "{{某个上游节点产出的变量}}"。'
        : `save-local: value ${flaggedEmpty ? '引用的变量/AI 结果为空' : '是空的'}，未写入 ${filename}（避免生成 0 字节文件）。`,
    )
  }

  // The write path itself is shared with `export-data` — see
  // `writeProducedFile` for the configured-directory-first policy and for why a
  // failed write fails the step.
  const outcome = await writeProducedFile('save-local', filename, { text: value }, ctx)
  if (outcome === 'saved') {
    // 与另存为路径保持一致：成功同样回填输出变量，避免下游读到陈旧值。
    // 取消或失败则保持原值，让下游能看出这一步没有产出。
    ctx.variables[variable] = filename
  }
  return null
}

const proxyExec: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  ctx.emit('info', 'proxy: 代理配置需浏览器级设置，当前为占位实现')
  return null
}

const googleSheets: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  throw new Error('google-sheets: 需要 OAuth 凭据，尚未配置')
}

const googleDrive: BlockExecutor = async (_data, ctx) => {
  assertActive(ctx)
  throw new Error('google-drive: 需要 OAuth 凭据，尚未配置')
}

/**
 * Automa `wait-connections`: block until the tab the run is driving reaches
 * load state `complete` (or the configured `timeout` expires). After a click /
 * keypress that triggers navigation, the tab can still report `complete` for
 * the previous page, so give the navigation a short settle window before
 * listening. Best-effort: with no resolvable tab it returns immediately.
 */
const waitConnections: BlockExecutor = async (data, ctx) => {
  assertActive(ctx)
  let tabId = ctx.tabId
  if (typeof tabId !== 'number') {
    const tab = await resolveTargetTab(undefined, ctx.scope).catch(() => null)
    tabId = typeof tab?.id === 'number' ? tab.id : undefined
  }
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
  if (typeof tabId === 'number') {
    await waitForTabLoaded(tabId, ctx.signal, Math.max(1000, Number(data['timeout'] ?? 10000)))
  }
  ctx.emit('result', '页面已加载')
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
    const result = await execOnActiveTab(op, ctx.signal, ctx.tabId, ctx.scope)
    ctx.variables[variable] = result.data ?? {}
    ctx.emit('result', JSON.stringify(result.data ?? {}).slice(0, 80))
  } catch (error) {
    throw error
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
async function waitForTabLoaded(
  tabId: number | undefined,
  signal?: AbortSignal,
  maxMs = 15000,
): Promise<void> {
  if (typeof tabId !== 'number' || !chrome?.tabs?.onUpdated) return
  const check = await chrome.tabs.get(tabId).catch(() => null)
  if (check?.status === 'complete') return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      signal?.removeEventListener('abort', cancel)
      resolve()
    }, maxMs)
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

/**
 * Automa `forms` block: text/select/checkbox/radio input on one selector.
 *
 * The typed value supports `{{variable}}` tokens (e.g. the output variable of
 * an upstream `ai-agent` block). When the value consisted only of tokens that
 * resolved to an empty string — typically the AI step failed or produced no
 * text — the fill is skipped with an error instead of typing a blank or a
 * leftover `{{token}}` literal into the field.
 */
/** Human-readable locator summary of a forms/interaction block, for log lines. */
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

  // "Get form value" mode. Checked BEFORE the write path below, because that
  // path fills `value` — empty in this mode — which would CLEAR the very field
  // the user asked to read. The editor has offered this toggle since the port,
  // but nothing implemented it: the block silently wiped the control and no
  // variable was ever set.
  if (data['getValue'] === true) return readFormValue(data, target, ctx)

  if (type === 'checkbox' || type === 'radio') {
    const checked = typeof value === 'boolean' ? value : true
    ctx.emit('info', `[表单输入] ${describeBlockTarget(data)} ← ${checked ? '勾选' : '取消勾选'}`)
    return runRaw(withWait({ action: 'set_checkbox', target, value: checked }, data), ctx)
  }
  const raw = String(value ?? '')
  const filled = interpolate(raw, ctx.variables, ctx.refData)
  // Two ways to learn "the reference produced nothing":
  //  - `raw` still holds the token (this executor was called directly, e.g. by
  //    the generation-time operator bridge);
  //  - the engine already interpolated the bag and flagged the param, so `raw`
  //    is empty and only the flag tells it apart from a deliberate "".
  const flaggedEmpty = (data[EMPTY_INTERP_KEY] as string[] | undefined)?.includes('value') === true
  if (flaggedEmpty || (raw.includes('{{') && filled.trim() === '')) {
    // Name the param that resolved to nothing. With an already-interpolated bag
    // the original text is gone, so there is no value left to echo.
    ctx.emit(
      'info',
      flaggedEmpty
        ? '[表单输入] 原值: value 引用的变量/AI 结果为空'
        : `[表单输入] 原值: ${logPreview(raw, 120)}`,
    )
    throw new Error('表单值引用的变量/AI 结果为空，无法填写')
  }
  // Input echo: what will be typed, and where — the two things a "did it fill
  // the right thing?" investigation needs.
  ctx.emit('info', `[表单输入] ${describeBlockTarget(data)} ← ${logPreview(filled, 120) || '(空)'}`)
  if (type === 'select') {
    return runRaw(withWait({ action: 'select_option', target, value: filled }, data), ctx)
  }
  return runRaw(
    withWait({ action: 'fill', target, value: filled, clear: data['clearValue'] !== false }, data),
    ctx,
  )
}

/**
 * "Get form value" mode of the `forms` block: read ONE control's live value
 * into `variableName` instead of writing to it.
 *
 * A read needs somewhere to put the result, so a missing variable name is an
 * error rather than a silent no-op — the model (and the user editing the node)
 * gets told, instead of the workflow continuing with a variable that never
 * exists. The value keeps its native type (checkbox → boolean, multi-select →
 * array), which is what downstream operators such as `conditions` compare
 * against.
 */
async function readFormValue(
  data: Record<string, unknown>,
  target: Target,
  ctx: WorkflowExecCtx,
): Promise<string | null> {
  const variable = String(data['variableName'] ?? '').trim()
  if (!variable) {
    throw new Error('读取表单值需要填写变量名（variableName），无法读取')
  }
  try {
    const result = await execOnActiveTab(
      withWait({ action: 'get_value', target }, data),
      ctx.signal,
      ctx.tabId,
      ctx.scope,
    )
    if (result && result.ok === false) throw new Error(result.error || '读取表单值失败')
    ctx.variables[variable] = result?.data
    ctx.emit(
      'info',
      `[表单读取] ${describeBlockTarget(data)} → {{${variable}}} = ${previewValue(result?.data)}`,
    )
    ctx.emit('result', previewValue(result?.data))
  } catch (error) {
    throw error
  }
  return null
}

/** Human-readable form of a read value, for the run log. */
function previewValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? '已勾选' : '未勾选'
  if (Array.isArray(value)) return value.length ? value.map(String).join(', ') : '(空)'
  const text = String(value ?? '')
  return text === '' ? '(空)' : logPreview(text, 120)
}

/** Automa `element-scroll` block: scroll an element or the window by X/Y. */
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
      return runRaw(
        withWait(
          { action: 'scroll', target: targetFrom(data), scroll: { mode: 'into_view' } },
          data,
        ),
        ctx,
      )
    }
    return runRaw(
      withWait(
        { action: 'scroll', target: targetFrom(data), scroll: { mode: 'by', x, y, smooth } },
        data,
      ),
      ctx,
    )
  }
  // No CSS selector: a conversation-generated node may still carry the rich
  // locator — scrollIntoView applies to that element.
  if (data['scrollIntoView'] && richTargetOf(data)) {
    return runRaw(
      withWait({ action: 'scroll', target: targetFrom(data), scroll: { mode: 'into_view' } }, data),
      ctx,
    )
  }
  return runRaw({ action: 'scroll', scroll: { mode: 'by', x, y, smooth } }, ctx)
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
      if (typeof left === 'number' || typeof right === 'number')
        return Number(left) === Number(right)
      return String(left ?? '') === String(right ?? '')
  }
}

/** Automa `event-click` / `hover-element` respect waitForSelector too. */
const eventClick: BlockExecutor = async (data, ctx) =>
  runRaw(withWait({ action: 'click', target: targetFrom(data) }, data), ctx)
const hoverElement: BlockExecutor = async (data, ctx) =>
  runRaw(withWait({ action: 'hover', target: targetFrom(data) }, data), ctx)

/**
 * Automa `loop-breakpoint` block: unwinds out of the enclosing loop by
 * throwing the sentinel the engine catches at the owning loop (which resumes
 * from that loop's "end" branch). A non-empty `loopId` targets a specific
 * outer loop; without one the innermost enclosing loop breaks. runNode
 * rethrows the sentinel before any onError handling, so this block is never
 * retried, fallback-routed or failed.
 */
const loopBreakpointExec: BlockExecutor = async (data) => {
  const raw = data['loopId']
  const loopId = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
  throw new LoopBreakpointError(loopId)
}

/**
 * Block-executor registry, keyed by block id. The engine resolves the block id
 * from `WorkflowNode.data.blockId` (falling back to the legacy `label` field)
 * and dispatches through this map.
 */
export const EXECUTORS: Record<string, BlockExecutor> = {
  // browser
  click: click,
  fill: fill,
  'select-option': selectOption,
  scroll: scroll,
  'press-key': pressKey,
  'wait-for': waitFor,
  'take-screenshot': takeScreenshot,
  'read-page': readPage,
  'get-text': getText,
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
  'get-secret': getSecret,
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
  // browser actions (phase 2)
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
  'ai-agent': aiAgent,
  'execute-workflow': placeholder('execute-workflow'),
  'parameter-prompt': parameterPrompt,
  'switch-to': switchToExec,
  'trigger-event': triggerEventExec,
  'browser-event': browserEvent,
  'handle-download': handleDownload,
  'save-local': saveLocal,
  'save-assets': saveAssetsExec,
  proxy: proxyExec,
  'google-sheets': googleSheets,
  'google-drive': googleDrive,
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
