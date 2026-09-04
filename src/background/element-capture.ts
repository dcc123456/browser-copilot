/**
 * Robust element screenshot for the service-worker side, shared by the agent's
 * recognize/screenshot tools and the workflow engine's ocr block.
 *
 * Capturing an element in-page serializes it into an SVG foreignObject and
 * rasterizes it — but the load of that SVG data URL is subject to the PAGE's
 * CSP (`img-src` without `data:` blocks it, the observed "SVG 加载失败"), and
 * oversized subtrees can exceed the data-URL budget. The capture therefore
 * runs three strategies per attempt and retries with a pause (late-rendered
 * captchas):
 *
 * 1. Scroll the element into view (kernel scroll op — pierces open shadow
 *    roots), so both the serialized capture and the visible-page crop can
 *    actually see it.
 * 2. The in-page capture op — works for off-screen elements, with `waitFor`
 *    polling for elements that appear late.
 * 3. Fallback: capture the visible page (extension API — no page CSP can
 *    block it) and crop it to the element's viewport rect via OffscreenCanvas;
 *    the rect probe scrolls the element into view before reading its rect.
 *
 * @module background/element-capture
 */
import { execOnActiveTab, resolveAutomationTab } from './driver'
import { captureVisiblePage } from './capture'
import { fetchImageAsDataUrl } from '../lib/fetch-image'
import type { ScopeWindow } from './automation-scope'
import type { Target } from '../lib/ops'

/** How often the element capture retries before reporting failure. */
const CAPTURE_ATTEMPTS = 3
/** Pause between capture attempts. */
const CAPTURE_RETRY_MS = 1200

/**
 * Maps an element's viewport rect (CSS px) onto the captured page image
 * (physical px = CSS px × devicePixelRatio), clamped to the image bounds.
 * Returns null when the element sits (almost) entirely outside the viewport —
 * the visible-page capture cannot contain it.
 */
export function cropRectFor(
  rect: { x: number; y: number; w: number; h: number; dpr: number },
  imageW: number,
  imageH: number,
): { x: number; y: number; w: number; h: number } | null {
  const sx = rect.x * rect.dpr
  const sy = rect.y * rect.dpr
  const sw = rect.w * rect.dpr
  const sh = rect.h * rect.dpr
  const x = Math.max(0, Math.floor(sx))
  const y = Math.max(0, Math.floor(sy))
  const right = Math.min(imageW, Math.ceil(sx + sw))
  const bottom = Math.min(imageH, Math.ceil(sy + sh))
  if (right - x < 2 || bottom - y < 2) return null
  return { x, y, w: right - x, h: bottom - y }
}

/**
 * Frame (iframe/frame) inventory entry collected by {@link probeTopDocument}:
 * the frame's location href and its rect relative to the TOP viewport, used to
 * translate a cross-origin frame's own element coordinates into top-viewport
 * coordinates for the crop.
 */
interface FrameInventoryEntry {
  href: string
  rect: { x: number; y: number; w: number; h: number }
}

/** Result shape shared by the in-page probes (structured-cloneable). */
type FrameProbeResult =
  | {
      state: 'ok'
      rect: { x: number; y: number; w: number; h: number; dpr: number }
      href: string
    }
  | { state: 'empty'; href: string; inventory: FrameInventoryEntry[] }
  | { state: 'missing'; href: string; inventory: FrameInventoryEntry[] }

/** Reads a frame element's content location; cross-origin href is readable. */
function frameHref(frame: Element): string {
  try {
    const win = (frame as HTMLIFrameElement).contentWindow
    if (win?.location?.href) return win.location.href
  } catch {
    /* cross-origin — fall through to the attribute */
  }
  return String(frame.getAttribute('src') ?? '')
}

/**
 * Rect probe injected into the page's TOP frame for the crop fallback. Covers
 * MORE than the top document:
 *
 *  - the element itself in the top document;
 *  - SAME-ORIGIN iframes, recursed with exact offsets (each ancestor iframe's
 *    rect accumulates into the element's top-viewport position);
 *  - an INVENTORY of every reachable frame's href + top-viewport rect, so the
 *    worker can translate a CROSS-ORIGIN frame's own coordinates (its probe
 *    can only see its own viewport) by matching href.
 *
 * The element is scrolled into view within its own frame FIRST — a
 * below-the-fold captcha must become visible before the visible-page capture
 * can contain it. "missing" reports what was checked; "empty" means the
 * element exists with zero size (hidden).
 */
export function probeTopDocument(selector: string): FrameProbeResult {
  const inventory: FrameInventoryEntry[] = []

  const collect = (doc: Document, baseX: number, baseY: number, depth: number): void => {
    if (depth > 4) return
    for (const frame of Array.from(doc.querySelectorAll('iframe,frame'))) {
      const r = frame.getBoundingClientRect()
      inventory.push({
        href: frameHref(frame),
        rect: { x: baseX + r.x, y: baseY + r.y, w: r.width, h: r.height },
      })
      try {
        const child = (frame as HTMLIFrameElement).contentDocument
        if (child) collect(child, baseX + r.x, baseY + r.y, depth + 1)
      } catch {
        /* cross-origin — the all-frames probe covers it */
      }
    }
  }

  /**
   * Finds the element in this document or any same-origin descendant frame.
   * Returns the element plus its top-viewport offset chain base.
   */
  const find = (
    doc: Document,
    baseX: number,
    baseY: number,
    depth: number,
  ): { el: Element; x: number; y: number } | null => {
    const el = doc.querySelector(selector)
    if (el) return { el, x: baseX, y: baseY }
    if (depth > 4) return null
    for (const frame of Array.from(doc.querySelectorAll('iframe,frame'))) {
      try {
        const child = (frame as HTMLIFrameElement).contentDocument
        if (!child) continue
        const r = frame.getBoundingClientRect()
        const hit = find(child, baseX + r.x, baseY + r.y, depth + 1)
        if (hit) return hit
      } catch {
        /* cross-origin */
      }
    }
    return null
  }

  const scroll = (el: Element): void => {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' })
    } catch {
      try {
        ;(el as HTMLElement).scrollIntoView()
      } catch {
        /* no scrolling */
      }
    }
  }

  collect(document, 0, 0, 0)
  const href = location.href

  // First pass finds the element; scrolling inside its frame changes its own
  // rect, so a second pass measures AFTER the scroll.
  const hit = find(document, 0, 0, 0)
  if (!hit) {
    const top = document.querySelector(selector)
    if (top) {
      // Unreachable — find() would have returned it — kept for exhaustiveness.
      scroll(top)
      const r = top.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return { state: 'empty', href, inventory }
      return {
        state: 'ok',
        rect: { x: r.x, y: r.y, w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 },
        href,
      }
    }
    return { state: 'missing', href, inventory }
  }
  scroll(hit.el)
  const measured = find(document, 0, 0, 0)
  const target = measured?.el ?? hit.el
  const base = measured ?? hit
  const r = target.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return { state: 'empty', href, inventory }
  return {
    state: 'ok',
    rect: {
      x: base.x + r.x,
      y: base.y + r.y,
      w: r.width,
      h: r.height,
      dpr: window.devicePixelRatio || 1,
    },
    href,
  }
}

/**
 * Per-frame probe injected into EVERY frame (allFrames) for the cross-origin
 * case: the kernel already broadcasts the capture op to all frames, but a
 * frame's own coordinates are relative to ITS viewport — the worker combines
 * them with {@link probeTopDocument}'s frame inventory to get top-viewport
 * positions. Reports the frame's own href for matching.
 */
export function probeInFrame(selector: string): FrameProbeResult {
  const href = location.href
  const el = document.querySelector(selector)
  if (!el) return { state: 'missing', href, inventory: [] }
  try {
    el.scrollIntoView({ block: 'center', inline: 'center' })
  } catch {
    try {
      ;(el as HTMLElement).scrollIntoView()
    } catch {
      /* no scrolling */
    }
  }
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return { state: 'empty', href, inventory: [] }
  return {
    state: 'ok',
    rect: { x: r.x, y: r.y, w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 },
    href,
  }
}

/** Compares two frame hrefs ignoring query/hash (captcha URLs rotate params). */
function sameFrame(a: string, b: string): boolean {
  const norm = (u: string): string => {
    try {
      const parsed = new URL(u)
      return `${parsed.origin}${parsed.pathname}`
    } catch {
      return u
    }
  }
  return norm(a) === norm(b) && norm(a) !== ''
}

export interface ElementCaptureOptions {
  /** Cancellation for the retry pauses (AbortError propagates). */
  signal?: AbortSignal
  /** Panel-window scope for tab resolution (undefined = global). */
  scope?: ScopeWindow
  /** Tab pinned for this run, when the caller has one. */
  preferredTabId?: number
}

export type ElementCaptureResult =
  | { ok: true; dataUrl: string }
  | { ok: false; error: string }

/**
 * Captures an element's rendering as a PNG data URL — see the module doc for
 * the strategy chain. Errors are final and self-contained (no tool prefix);
 * callers add their own context (`ocr: …` / `Could not capture …`).
 */
export async function captureElementRobust(
  selector: string,
  opts: ElementCaptureOptions = {},
): Promise<ElementCaptureResult> {
  const { signal, scope, preferredTabId } = opts
  const target: Target = { primary: { how: 'css', value: selector }, fallbacks: [] }
  let lastError: string | undefined
  let lastTabUrl: string | undefined

  for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt += 1) {
    // Best-effort scroll into view — the serialized capture does not need the
    // element on screen, but the visible-page crop fallback does.
    try {
      await execOnActiveTab(
        { action: 'scroll', target, scroll: { mode: 'into_view' } },
        signal,
        preferredTabId,
        scope,
      )
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
    }

    try {
      const result = await execOnActiveTab(
        { action: 'capture', value: selector, waitFor: 2000 },
        signal,
        preferredTabId,
        scope,
      )
      if (result.ok && typeof result.data === 'string') {
        // The in-page op returns an http(s) src for <img> targets (rasterizing
        // them through SVG would be CSP-blocked and blurrier). Download the
        // ORIGINAL pixels here — with cookies, so session-bound captchas work.
        // A failed download falls through to the raster fallback attempts.
        if (/^https?:\/\//i.test(result.data)) {
          const downloaded = await fetchImageAsDataUrl(result.data)
          if (downloaded.ok) return { ok: true, dataUrl: downloaded.dataUrl }
          lastError = downloaded.error
        } else {
          return { ok: true, dataUrl: result.data }
        }
      }
      if (result.error) lastError = result.error
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
    }

    // Fallback: visible-page capture + in-worker crop. The probe chain is
    // frame-aware: the top-frame probe covers the top document AND same-origin
    // iframes (recursive walk with exact offsets); a cross-origin frame that
    // holds the element is located via the all-frames probe + href matching
    // against the top probe's frame inventory.
    //
    // Tab resolution MUST match the scroll/capture ops above
    // (resolveAutomationTab — honors the run's pinned tab, skips non-injectable
    // pages, and falls back to the last focused normal window when the focused
    // window is the workflow editor / popup). A raw activeTab() here resolved
    // to the editor tab itself whenever the user runs a workflow from the
    // editor, and every probe then failed with "cannot access
    // chrome-extension://…".
    const tab = await resolveAutomationTab(preferredTabId, scope)
    lastTabUrl = tab?.url
    if (!tab || typeof tab.id !== 'number') {
      return { ok: false, error: `无法截取元素 ${selector} — 没有可操作的网页标签页（请先在普通 http(s) 页面上运行）` }
    }

    let rect:
      | { x: number; y: number; w: number; h: number; dpr: number }
      | null = null
    let sawEmpty = false
    let probeError: string | undefined
    const probedFrameHrefs: string[] = []

    const [topInjection] = await chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        func: probeTopDocument,
        args: [selector],
      })
      .catch((error: unknown) => {
        probeError = error instanceof Error ? error.message : String(error)
        return []
      })
    const topProbe = (topInjection?.result ?? null) as FrameProbeResult | null
    if (topProbe) probedFrameHrefs.push(topProbe.href)
    if (topProbe?.state === 'ok') {
      rect = topProbe.rect
    } else if (topProbe?.state === 'empty') {
      sawEmpty = true
    }

    if (!rect) {
      // Cross-origin frames the top probe cannot enter: ask every frame.
      const injections = await chrome.scripting
        .executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: probeInFrame,
          args: [selector],
        })
        .catch(() => [])
      let unlocatable: string | null = null
      for (const injection of injections ?? []) {
        const probe = injection?.result as FrameProbeResult | undefined
        if (!probe) continue
        if (probe.state === 'empty') sawEmpty = true
        if (probe.state !== 'ok') continue
        if (injection.frameId === 0) {
          // Top frame — its own coordinates are already top-viewport.
          rect = probe.rect
          break
        }
        probedFrameHrefs.push(probe.href)
        const inventory = topProbe && topProbe.state !== 'ok' ? topProbe.inventory : []
        const host = inventory.find((entry) => sameFrame(entry.href, probe.href))
        if (host) {
          rect = {
            x: probe.rect.x + host.rect.x,
            y: probe.rect.y + host.rect.y,
            w: probe.rect.w,
            h: probe.rect.h,
            dpr: probe.rect.dpr,
          }
          break
        }
        unlocatable = probe.href
      }
      if (!rect && unlocatable) {
        // Found, but its position in the page cannot be computed (nested
        // cross-origin frames) — retrying cannot fix that.
        return {
          ok: false,
          error:
            `元素 ${selector} 在跨域框架 ${unlocatable} 中找到，但无法换算其在页面中的位置` +
            '（嵌套跨域框架，暂不支持裁剪）',
        }
      }
    }

    if (rect) {
      const page = await captureVisiblePage(scope, { format: 'png', tab })
      if (!page.ok) return { ok: false, error: page.error }
      if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
        return { ok: false, error: `无法截取元素 ${selector}（运行环境不支持离屏裁剪）` }
      }
      let bitmap: ImageBitmap
      try {
        const res = await fetch(page.dataUrl)
        bitmap = await createImageBitmap(await res.blob())
      } catch {
        return { ok: false, error: `无法解码页面截图以裁剪元素 ${selector}` }
      }
      try {
        const crop = cropRectFor(rect, bitmap.width, bitmap.height)
        if (!crop) {
          lastError = `元素 ${selector} 不在可视区域内`
        } else {
          const canvas = new OffscreenCanvas(crop.w, crop.h)
          const canvasCtx = canvas.getContext('2d')
          if (!canvasCtx) {
            return { ok: false, error: `无法创建离屏画布以裁剪元素 ${selector}` }
          }
          canvasCtx.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h)
          const blob = await canvas.convertToBlob({ type: 'image/png' })
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
            reader.onerror = () => reject(reader.error)
            reader.readAsDataURL(blob)
          })
          if (dataUrl.startsWith('data:image/')) return { ok: true, dataUrl }
          lastError = `裁剪元素 ${selector} 失败`
        }
      } finally {
        bitmap.close()
      }
    } else if (sawEmpty) {
      lastError = `元素 ${selector} 存在但尺寸为 0（可能隐藏或尚未渲染）`
    } else {
      // Nowhere in ANY frame: the selector does not match at run time — a
      // dynamic/stale id, or content that never rendered. Listing the checked
      // frames makes an iframe mismatch obvious.
      const frames = probedFrameHrefs.length
        ? `已检查的框架: ${probedFrameHrefs.slice(0, 3).join(' | ')}`
        : probeError
          ? `框架探测不可用: ${probeError}`
          : '框架列表不可用'
      lastError =
        `所有框架中均找不到元素 ${selector}（选择器不匹配、元素未渲染或动态 id）— ${frames}` +
        '。SVG 序列化截图也被页面 CSP 拦截；可在对话里用图片地址识别（重放为变量源）。'
    }

    if (attempt < CAPTURE_ATTEMPTS) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, CAPTURE_RETRY_MS)
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
  }

  return {
    ok: false,
    error:
      `无法截取元素 ${selector} — ${lastError ?? '截图失败'}` +
      (lastTabUrl ? `（作用的标签页: ${lastTabUrl.slice(0, 100)}）` : '') +
      '。已尝试滚动到元素并重试；SVG 序列化截图会被页面 CSP 拦截。',
  }
}
