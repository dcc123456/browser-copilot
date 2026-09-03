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
import { execOnActiveTab } from './driver'
import { activeTab } from './page'
import { captureVisiblePage } from './capture'
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
 * Rect probe injected into the page's top frame for the crop fallback. Scrolls
 * the element into view FIRST — a below-the-fold captcha must become visible
 * before the visible-page capture can contain it — then reports its viewport
 * rect. Distinguishes "not in this document" (missing) from "zero size"
 * (hidden), so the error tells the user what actually happened.
 */
export function elementRectInPage(
  selector: string,
):
  | { state: 'ok'; rect: { x: number; y: number; w: number; h: number; dpr: number } }
  | { state: 'missing' }
  | { state: 'empty' } {
  const el = document.querySelector(selector)
  if (!el) return { state: 'missing' }
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
  if (r.width <= 0 || r.height <= 0) return { state: 'empty' }
  return {
    state: 'ok',
    rect: { x: r.x, y: r.y, w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 },
  }
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
      if (result.ok && typeof result.data === 'string') return { ok: true, dataUrl: result.data }
      if (result.error) lastError = result.error
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
    }

    // Fallback: visible-page capture + in-worker crop.
    const tab = await activeTab(scope)
    if (!tab || typeof tab.id !== 'number') {
      return { ok: false, error: `无法截取元素 ${selector} — 没有活动标签页` }
    }
    const [injection] = await chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        func: elementRectInPage,
        args: [selector],
      })
      .catch(() => [])
    const probe = (injection?.result ?? null) as
      | { state: 'ok'; rect: { x: number; y: number; w: number; h: number; dpr: number } }
      | { state: 'missing' }
      | { state: 'empty' }
      | null

    if (probe?.state === 'ok') {
      const rect = probe.rect
      const page = await captureVisiblePage(scope, { format: 'png' })
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
    } else if (probe?.state === 'empty') {
      lastError = `元素 ${selector} 存在但尺寸为 0（可能隐藏或尚未渲染）`
    } else {
      // 'missing' or the injection itself failed — the element is not in the
      // TOP document: it may render later, or live inside an iframe / closed
      // shadow root where this probe cannot reach.
      lastError = `顶层文档中找不到元素 ${selector}（可能在 iframe 内或尚未渲染）`
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
      '。已尝试滚动到元素并重试；SVG 序列化截图会被页面 CSP 拦截。',
  }
}
