/**
 * Image recognition via an OpenAI-compatible vision model.
 *
 * The active chat provider (e.g. `deepseek-chat`) is usually text-only, so the
 * `recognize_image` tool talks to a separately configured vision-capable model
 * (gpt-4o, qwen-vl, glm-4v, …) — see `Settings.imageModel` — to read text out of
 * a captcha or any other image on the page.
 *
 * The wire format is the same OpenAI-compatible `POST {baseUrl}/chat/completions`
 * used for chat, but with a multimodal user message (`image_url` content part)
 * and a single, non-streaming completion.
 *
 * The request-building and error-mapping helpers are pure so they are testable
 * under Node; the browser-only bits (OffscreenCanvas preprocessing) live in
 * {@link preprocessImage}.
 *
 * @module lib/vision
 */

import { normalizeBaseUrl, type ProviderProfile } from './providers'

export interface VisionConfig {
  /** Provider id whose credentials are reused; empty = resolve from the active provider. */
  providerId: string
  /** Optional model override; empty = use the selected provider's default model. */
  model: string
}

/** A fully resolved model target (either the configured provider or a fallback). */
export interface ResolvedVisionTarget {
  baseUrl: string
  apiKey: string
  model: string
  /** Which source supplied it, for error messages. */
  source: 'imageModel' | 'activeProvider'
}

/**
 * Resolves the vision endpoint from the configuration and the provider list:
 * uses the explicitly selected provider's credentials when one is picked
 * (model overridable), otherwise the active chat provider. Returns null when
 * neither can be resolved into a usable endpoint.
 */
export function resolveVisionTarget(
  imageModel: VisionConfig,
  providers: readonly ProviderProfile[],
  activeProvider: ProviderProfile | undefined,
): ResolvedVisionTarget | null {
  const picked =
    imageModel.providerId && providers.find((p) => p.id === imageModel.providerId)
  if (picked && picked.baseUrl && picked.apiKey) {
    return {
      baseUrl: normalizeBaseUrl(picked.baseUrl),
      apiKey: picked.apiKey,
      model: imageModel.model.trim() || picked.model,
      source: 'imageModel',
    }
  }
  if (activeProvider && activeProvider.baseUrl && activeProvider.apiKey && activeProvider.model) {
    return {
      baseUrl: normalizeBaseUrl(activeProvider.baseUrl),
      apiKey: activeProvider.apiKey,
      model: activeProvider.model,
      source: 'activeProvider',
    }
  }
  return null
}

/**
 * Builds the request body for one recognition call. Pure so tests can assert the
 * exact payload (multimodal image part, no tooling, single completion).
 */
export function buildVisionRequestBody(target: ResolvedVisionTarget, dataUrl: string, prompt: string): Record<string, unknown> {
  return {
    model: target.model,
    stream: false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  }
}

/** A compact, task-appropriate recognition instruction. */
export function defaultRecognitionPrompt(extra?: string): string {
  const base =
    'The image to analyze is attached directly to this request — do not fetch, load, or locate any image from a URL, link, or file path. Read the characters and text in the attached image exactly as they appear and return ONLY the recognized content — no explanation, no quotes, no labels. Preserve case, digits, and punctuation.'
  return extra && extra.trim() ? `${base}\n\nUser request: ${extra.trim()}` : base
}

/** Maps a bare message string from the vendor to an actionable error line. */
function describeFailure(body: string, status: number): string {
  let detail = ''
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string
      message?: string
    }
    detail =
      typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message ?? '')
  } catch {
    detail = body.slice(0, 200)
  }
  const suffix = detail ? `: ${detail}` : ''
  switch (status) {
    case 401:
    case 403:
      return `The image model rejected the API key (${status})${suffix}`
    case 404:
      return `The image model has no such endpoint or model (404); check the base URL and model name${suffix}`
    case 429:
      return `The image model is rate limited (429)${suffix}`
    default:
      return `The image model request failed (${status} ${suffix.trim() || 'unknow status'})`
  }
}

/**
 * Calls a vision model to recognize the image and returns the recognized text.
 * Soft-fails into `{ ok: false, error }` instead of throwing so the tool can hand
 * a stable message back to the model.
 */
/** Shared request/response plumbing for a single vision-model call. */
async function callVisionModel(
  target: ResolvedVisionTarget,
  dataUrl: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const url = `${target.baseUrl}/chat/completions`
  const body = buildVisionRequestBody(target, dataUrl, prompt)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    return { ok: false, error: `Cannot reach ${url}: ${(error as Error)?.message ?? String(error)}` }
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { ok: false, error: describeFailure(text, response.status) }
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, error: 'The image model returned an unreadable response.' }
  }
  const content = (payload as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content
  if (typeof content === 'string' && content.trim().length > 0) {
    return { ok: true, text: content.trim() }
  }
  return { ok: false, error: 'The image model returned no text for this image.' }
}

/**
 * Calls a vision model to recognize the image and returns the recognized text.
 * Soft-fails into `{ ok: false, error }` instead of throwing so the tool can hand
 * a stable message back to the model.
 */
export async function recognizeImage(
  target: ResolvedVisionTarget,
  dataUrl: string,
  opts: { prompt?: string; signal?: AbortSignal } = {},
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return callVisionModel(target, dataUrl, defaultRecognitionPrompt(opts.prompt), opts.signal)
}

/**
 * Calls the vision model to *inspect* a screenshot of an element/page — read any
 * text/CAPTCHA exactly AND describe what the element is and its on-screen state.
 * Unlike {@link recognizeImage} this does not force a "text only" answer.
 */
export async function inspectImage(
  target: ResolvedVisionTarget,
  dataUrl: string,
  opts: { prompt?: string; signal?: AbortSignal } = {},
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const custom = opts.prompt?.trim()
  const prompt = custom
    ? `Inspect this screenshot of a page element. ${custom}`
    : 'Inspect this screenshot of a page element. Read any visible text or CAPTCHA exactly as it appears, then briefly describe what the element is and its current on-screen state.'
  return callVisionModel(target, dataUrl, prompt, opts.signal)
}

/**
 * Lightweight captcha preprocessing: grayscale + basic contrast boost to make
 * faint/coloured noise easier for a vision model to read. Uses OffscreenCanvas
 * (service-worker safe). Returns the original data URL unchanged when the
 * runtime has no OffscreenCanvas or decoding fails — recognition should never
 * be blocked by a convenience step.
 */
export async function preprocessImage(dataUrl: string): Promise<string> {
  if (typeof OffscreenCanvas === 'undefined') return dataUrl
  let bitmap: ImageBitmap
  try {
    const res = await fetch(dataUrl)
    bitmap = await createImageBitmap(await res.blob())
  } catch {
    return dataUrl
  }
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return dataUrl
    ctx.drawImage(bitmap, 0, 0)
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    const px = imageData.data
    for (let i = 0; i < px.length; i += 4) {
      // Relative luminance → grayscale, then stretch contrast around the mean.
      const l = 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!
      const boosted = 128 + (l - 128) * 1.5
      const v = Math.max(0, Math.min(255, boosted))
      px[i] = v
      px[i + 1] = v
      px[i + 2] = v
    }
    ctx.putImageData(imageData, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return await blobToDataUrl(blob)
  } catch {
    return dataUrl
  } finally {
    bitmap.close()
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}