/**
 * The server runner's browser driver — the Playwright port of the extension's
 * `background/driver.ts`.
 *
 * The extension drives the user's active tab through `chrome.scripting`
 * injections of the self-contained in-page kernel (`inpage/kernel.ts`). The
 * runner drives headless pages through Playwright's `evaluate`, which
 * serializes the SAME kernel functions the same way (function source only) —
 * so every DOM strategy, the `waitFor` polling and the Automa JS harness
 * behave identically.
 *
 * Ported semantics that matter:
 * - one op runs in ALL frames of the page; results are ranked
 *   (found > ok > top frame) and the best one wins;
 * - a navigation that destroys the evaluation context mid-op is reported as
 *   success with `mayNavigate` (the click did in fact work);
 * - JS ops (`exec_js` / `exec_workflow_js`) run in the MAIN world of the top
 *   frame only;
 * - unattended runs never hang on dialogs: every page auto-accepts them.
 *
 * Tabs are tracked per run (a run session = one browser context); numeric tab
 * ids are minted here and flow through the engine's opaque `ctx.tabId`.
 *
 * @module server/driver
 */

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { BrowserContext, Download, Frame, Page } from 'playwright'
import { runExecJs, runOp, runWorkflowJs } from '../../src/inpage/kernel'
import type { Op, OpResult } from '../../src/lib/ops'
import type { RunSession } from './browser-pool'

export class DriverError extends Error {}

export interface DriverTab {
  id: number
  url: string
  title: string
}

interface RecordedDownload {
  filename: string
  path: string | null
  url: string
}

/** Matches the extension's `isContextLost` family of navigation races. */
function isContextLost(message: string): boolean {
  return (
    /Execution context was destroyed/i.test(message) ||
    /Frame was detached/i.test(message) ||
    /context destroyed/i.test(message)
  )
}

export class RunDriver {
  private pages: Page[] = []
  private pageIds = new Map<Page, number>()
  private nextId = 1
  private active: Page | null = null
  private downloads: RecordedDownload[] = []

  constructor(readonly session: RunSession) {
    // A persistent profile may come with pages already open (a previous run
    // left them there). Adopt them so switch-tab/loop-elements see them.
    for (const page of session.context.pages()) this.register(page)
    // Unattended runs never hang on a native dialog.
    this.session.context.on('page', (page) => this.register(page))
  }

  /** Registers a page: numeric id, dialog auto-accept, download recording. */
  private register(page: Page): void {
    if (this.pageIds.has(page)) return
    this.pages.push(page)
    this.pageIds.set(page, this.nextId++)
    if (!this.active) this.active = page
    // Every new document gets the esbuild-keepNames no-op helper BEFORE any
    // kernel function evaluation (prepFrame is the belt, this the braces).
    void page
      .addInitScript(() => {
        const global = globalThis as { __name?: unknown }
        if (typeof global.__name !== 'function') {
          global.__name = (fn: unknown) => fn
        }
      })
      .catch(() => {})
    page.on('dialog', (dialog) => {
      dialog.accept().catch(() => {})
    })
    page.on('download', (download) => {
      void this.saveDownload(download)
    })
    page.on('close', () => {
      this.pages = this.pages.filter((p) => p !== page)
      this.pageIds.delete(page)
      if (this.active === page) this.active = this.pages[this.pages.length - 1] ?? null
    })
  }

  /** Saves a download into the run's artifacts directory (best-effort). */
  private async saveDownload(download: Download): Promise<void> {
    const filename = download.suggestedFilename() || 'download.bin'
    const dir = this.session.artifactsDir ?? join(tmpdir(), 'bc-runner-downloads')
    try {
      mkdirSync(dir, { recursive: true })
      const safe = filename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      const path = join(dir, safe)
      await download.saveAs(path)
      this.downloads.push({ filename, path, url: download.url() })
    } catch (error) {
      this.downloads.push({ filename, path: null, url: download.url() })
      console.warn(`[runner] download save failed: ${(error as Error).message}`)
    }
  }

  // --- Tab registry -----------------------------------------------------------

  pageById(tabId: number): Page | undefined {
    for (const [page, id] of this.pageIds) if (id === tabId) return page
    return undefined
  }

  /** The currently active page (or null when the session has none). */
  activePage(): Page | null {
    return this.active && !this.active.isClosed() ? this.active : null
  }

  /** The active page's id (for tab-url / active-tab blocks). */
  activeTabId(): number | undefined {
    return this.active ? this.pageIds.get(this.active) : undefined
  }

  /** The page a file-upload block acts on (same resolution as ops). */
  pageForUpload(tabId?: number): Page {
    return this.pageOf(tabId)
  }

  private pageOf(tabId?: number): Page {
    const page = (tabId !== undefined ? this.pageById(tabId) : undefined) ?? this.active
    if (!page || page.isClosed()) {
      throw new DriverError(
        '没有可操作的网页：请先用「新建标签页」/「打开页面」块打开一个 http(s) 页面。',
      )
    }
    return page
  }

  private tabOf(page: Page): DriverTab {
    return { id: this.pageIds.get(page)!, url: page.url(), title: '' }
  }

  listTabs(): DriverTab[] {
    return this.pages.filter((p) => !p.isClosed()).map((page) => this.tabOf(page))
  }

  /**
   * Prepares a frame for kernel-function evaluation. The runner executes via
   * tsx/esbuild, whose `keepNames` transform injects `__name(fn, …)` helper
   * calls into the serialized function source — the helper only exists in the
   * Node bundle, not inside the page, so define a no-op there first.
   */
  private async prepFrame(frame: Frame): Promise<void> {
    await frame.evaluate(() => {
      const global = globalThis as { __name?: unknown }
      if (typeof global.__name !== 'function') {
        global.__name = (fn: unknown) => fn
      }
    })
  }

  // --- Tab management -----------------------------------------------------------

  async newTab(url?: string): Promise<DriverTab> {
    const page = await this.session.context.newPage()
    this.register(page)
    this.active = page
    if (url) {
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => {
        /* best-effort, like the extension's waitForTabLoaded */
      })
    }
    return { ...this.tabOf(page), title: await page.title().catch(() => '') }
  }

  async switchTab(index: number): Promise<DriverTab> {
    const open = this.pages.filter((p) => !p.isClosed())
    const page = open[Math.max(0, Math.floor(index))]
    if (!page) throw new DriverError(`switch-tab: 标签页序号不存在 (${index})`)
    this.active = page
    return { ...this.tabOf(page), title: await page.title().catch(() => '') }
  }

  async closeActiveTab(): Promise<void> {
    const page = this.pageOf()
    await page.close().catch(() => {})
  }

  async reloadTab(): Promise<void> {
    await this.pageOf().reload({ timeout: 30_000 }).catch(() => {})
  }

  async goBack(): Promise<void> {
    const page = this.pageOf()
    await page.goBack({ timeout: 15_000 }).catch(() => {})
  }

  async goForward(): Promise<void> {
    const page = this.pageOf()
    await page.goForward({ timeout: 15_000 }).catch(() => {})
  }

  async activeInfo(): Promise<DriverTab> {
    const page = this.pageOf()
    return { ...this.tabOf(page), title: await page.title().catch(() => '') }
  }

  /** Mirrors the extension's `waitForTabLoaded`: best-effort load-state wait. */
  async waitForLoaded(tabId?: number, maxMs = 15_000): Promise<void> {
    const page = this.pageOf(tabId)
    await page.waitForLoadState('load', { timeout: maxMs }).catch(() => {})
  }

  // --- Kernel ops -----------------------------------------------------------------

  /**
   * Runs one kernel op on the page (all frames, best result wins), porting the
   * extension's `execOnActiveTab` semantics.
   */
  async execOp(op: Op, tabId?: number): Promise<OpResult> {
    const page = this.pageOf(tabId)
    const frameUrl = page.url()

    // User JS runs in the MAIN world of the top frame, exactly like the
    // extension's CSP-exempt wrapper injection.
    if (op.action === 'exec_js') {
      await this.prepFrame(page.mainFrame())
      const out = await page.evaluate(runExecJs, {
        code: String(op.value ?? ''),
        ...(op.jsArgNames ? { argNames: op.jsArgNames } : {}),
        ...(op.jsArgs ? { args: op.jsArgs } : {}),
      })
      return out.ok
        ? { ok: true, found: true, frameUrl, isTopFrame: true, data: out.data }
        : { ok: false, found: true, frameUrl, isTopFrame: true, error: out.error }
    }

    if (op.action === 'exec_workflow_js') {
      await this.prepFrame(page.mainFrame())
      const args = (op.jsArgs ?? {}) as { variables?: Record<string, unknown>; timeout?: number }
      const payload = await page.evaluate(runWorkflowJs, {
        code: String(op.value ?? ''),
        ...(args.variables ? { variables: args.variables } : {}),
        ...(args.timeout !== undefined ? { timeout: args.timeout } : {}),
      })
      const logs = payload.logs
      if (payload.ok) {
        return {
          ok: true,
          found: true,
          frameUrl,
          isTopFrame: true,
          data: { result: payload.data, variables: payload.variables, logs },
        }
      }
      return { ok: false, found: true, frameUrl, isTopFrame: true, error: payload.error, data: { logs } }
    }

    // Element ops: run in every frame, rank like the extension.
    const results: OpResult[] = []
    let contextLost = false
    for (const frame of page.frames()) {
      try {
        await this.prepFrame(frame)
        const result = await frame.evaluate(runOp, op)
        if (result && typeof result === 'object') results.push(result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (isContextLost(message)) {
          contextLost = true
          continue
        }
        // Unscriptable frames (chrome://, detached) are skipped, like the
        // extension's per-frame injection failures.
      }
    }

    if (results.length === 0) {
      if (contextLost) {
        return {
          ok: true,
          found: true,
          frameUrl,
          isTopFrame: true,
          mayNavigate: true,
          note: 'The page navigated during this step.',
        }
      }
      throw new DriverError('No frame in this page could be scripted. The page may have just navigated.')
    }

    const rank = (result: OpResult): number =>
      (result.found ? 4 : 0) + (result.ok ? 2 : 0) + (result.isTopFrame ? 1 : 0)
    results.sort((a, b) => rank(b) - rank(a))
    return results[0]!
  }

  /** Evaluate user JS in the page (MAIN world); mirrors `execJsOnActiveTab`. */
  async execJs(
    code: string,
    args: Record<string, unknown> = {},
    tabId?: number,
  ): Promise<{ ok: true; data?: unknown } | { ok: false; error: string }> {
    // The kernel's exec heuristic runs expression-like sources directly but
    // statement-like sources as a function body. An IIFE (`(() => …)()`)
    // contains `=>`, so it is classified as statements — yet without a
    // `return` the body discards the IIFE's value. Give such sources the
    // explicit `return` they need.
    const trimmed = code.trim()
    const prepared =
      trimmed.startsWith('(') && trimmed.endsWith(')') && !/^return\b/.test(trimmed)
        ? `return ${trimmed};`
        : code
    const result = await this.execOp(
      { action: 'exec_js', value: prepared, jsArgs: args, jsArgNames: Object.keys(args) },
      tabId,
    )
    return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error ?? 'JavaScript execution failed' }
  }

  /** The workflow "JavaScript code" harness result. */
  async execWorkflowJs(
    code: string,
    variables: Record<string, unknown>,
    timeout: number,
    tabId?: number,
  ): Promise<
    | { ok: true; data: { result: unknown; variables?: Record<string, unknown>; logs: { level: string; message: string }[] } }
    | { ok: false; error: string; logs: { level: string; message: string }[] }
  > {
    const result = await this.execOp(
      { action: 'exec_workflow_js', value: code, jsArgs: { variables, timeout } },
      tabId,
    )
    const captured =
      result.data && typeof result.data === 'object'
        ? (((result.data as { logs?: { level: string; message: string }[] }).logs ?? []) as {
            level: string
            message: string
          }[])
        : []
    if (result.ok) {
      const payload = result.data as { result?: unknown; variables?: Record<string, unknown> }
      return { ok: true, data: { result: payload.result, variables: payload.variables, logs: captured } }
    }
    return { ok: false, error: result.error ?? 'JavaScript execution failed', logs: captured }
  }

  async countElements(selector: string, tabId?: number): Promise<number> {
    const result = await this.execOp({ action: 'count_elements', value: selector }, tabId)
    return typeof result.data === 'number' ? result.data : 0
  }

  async elementExists(selector: string, tabId?: number): Promise<number> {
    const result = await this.execOp({ action: 'element_exists', value: selector }, tabId)
    return typeof result.data === 'number' ? result.data : result.found ? 1 : 0
  }

  // --- Screenshots / clipboard / cookies / downloads -------------------------------

  /**
   * Visible-page screenshot as a PNG data URL. `fullpage`/`element` go through
   * the in-page kernel capture (same SVG path as the extension).
   */
  async screenshot(kind: 'page' | 'fullpage' | 'element', selector?: string): Promise<string> {
    const page = this.pageOf()
    if (kind === 'page') {
      const buffer = await page.screenshot({ type: 'png' })
      return `data:image/png;base64,${buffer.toString('base64')}`
    }
    const op: Op = { action: 'capture' }
    if (kind === 'element') op.value = selector
    const result = await this.execOp(op)
    if (result.ok && typeof result.data === 'string') return result.data
    throw new DriverError(result.error ?? '截图失败')
  }

  private async grantClipboard(): Promise<void> {
    try {
      await this.session.context.grantPermissions(['clipboard-read', 'clipboard-write'])
    } catch {
      // Remote (CDP) browsers may refuse; the read/write itself will report.
    }
  }

  async clipboardGet(): Promise<string> {
    await this.grantClipboard()
    return this.pageOf().evaluate(() => navigator.clipboard.readText())
  }

  async clipboardInsert(text: string): Promise<void> {
    await this.grantClipboard()
    await this.pageOf().evaluate((value) => navigator.clipboard.writeText(value), text)
  }

  async cookieGetAll(url?: string): Promise<{ name: string; value: string; domain: string; path: string }[]> {
    return this.session.context.cookies(url || undefined)
  }

  async cookieGet(name: string, url?: string): Promise<string | null> {
    const target = url || this.active?.url()
    if (!target) throw new DriverError('cookie: 需要 URL 才能读取')
    const cookies = await this.session.context.cookies(target)
    return cookies.find((cookie) => cookie.name === name)?.value ?? null
  }

  async cookieSet(name: string, value: string, url: string, expirationDate?: number): Promise<void> {
    await this.session.context.addCookies([
      {
        name,
        value,
        url,
        ...(expirationDate && expirationDate > 0 ? { expires: expirationDate } : {}),
      },
    ])
  }

  async cookieRemove(name: string, url: string): Promise<void> {
    // Playwright filters clears by name and/or domain; the URL gives the domain.
    const cookies = await this.session.context.cookies(url)
    const match = cookies.find((cookie) => cookie.name === name)
    if (!match) return
    await this.session.context.clearCookies({
      name,
      ...(match.domain ? { domain: match.domain } : {}),
    })
  }

  /**
   * Finds a download for the `handle-download` block: newest recorded download
   * matching the filename substring, or — when none yet — the next one within
   * `timeoutMs` (unattended equivalent of chrome.downloads.search).
   */
  async waitForDownload(
    filename?: string,
    timeoutMs = 30_000,
  ): Promise<{ id: string; filename: string; path: string | null; url: string } | null> {
    const matches = (entry: RecordedDownload): boolean =>
      !filename || entry.filename.includes(filename) || entry.url.includes(filename)
    const found = [...this.downloads].reverse().find(matches)
    if (found) {
      return { id: found.path ?? found.filename, filename: found.filename, path: found.path, url: found.url }
    }
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const fresh = [...this.downloads].reverse().find(matches)
      if (fresh) {
        return { id: fresh.path ?? fresh.filename, filename: fresh.filename, path: fresh.path, url: fresh.url }
      }
    }
    return null
  }

  /** Artifact path helper: absolute-or-relative per run artifacts dir. */
  artifactPath(filename: string): string {
    const dir = this.session.artifactsDir ?? tmpdir()
    const base = isAbsolute(dir) ? dir : join(process.cwd(), dir)
    return join(base, filename)
  }
}
