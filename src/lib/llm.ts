/**
 * Provider-agnostic chat-completions client (OpenAI-compatible wire format).
 *
 * There is deliberately no per-vendor code here. DeepSeek, Volcengine Ark,
 * OpenAI, OpenRouter, DashScope, Moonshot, Ollama and vLLM all expose the same
 * contract — `POST {baseUrl}/chat/completions`, `Bearer` auth, SSE frames of
 * `chat.completion.chunk`, `tools` function calling, `[DONE]` to terminate — so
 * a provider reduces to configuration. Vendor differences that do exist (path
 * version, model naming) live in the profile, not in this module.
 *
 * Streaming runs in the service worker rather than the side panel: extension
 * pages have no page origin to satisfy CORS from, and a panel can be closed
 * mid-turn without losing the run.
 *
 * @module lib/llm
 */

import { normalizeBaseUrl } from './providers'

export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** A completed tool call, replayed on assistant history messages. */
export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      /**
       * Empty string rather than null on tool-call-only turns: some
       * OpenAI-compatible gateways reject a null content field.
       */
      content: string | null
      tool_calls?: WireToolCall[]
    }
  | { role: 'tool'; tool_call_id: string; content: string; name?: string }

/** One in-progress tool call being assembled from deltas. */
interface PartialToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

/**
 * Token usage reported by the model for one completion. Fields mirror the
 * OpenAI usage object; providers that omit a field leave it undefined. Cached
 * input tokens (prompt token details) are surfaced separately so the UI can
 * show how much of the input was served from cache.
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** Tokens billed for cached prompt input, when the provider reports it. */
  cachedInputTokens?: number
  /** Reasoning/output-tokens-before-thinking, for reasoning models. */
  reasoningTokens?: number
  totalTokens: number
}

/** Terminal result of one streamed completion. */
export interface StreamResult {
  content: string
  toolCalls: WireToolCall[]
  finishReason: string | null
  usage: TokenUsage | null
}

/** Incremental events surfaced to the caller. */
export interface StreamHandlers {
  onText?: (delta: string) => void
  onToolCallStart?: (name: string) => void
  /** Fired once with the final usage block when the provider reports it. */
  onUsage?: (usage: TokenUsage) => void
}

/**
 * Accumulates SSE frames into a {@link StreamResult}.
 *
 * Kept separate from `fetch` so the chunk-splitting rules (frames arbitrarily
 * split across network reads, multi-fragment tool arguments, usage-only
 * trailing chunks) are unit-testable without a network.
 */
export class SseAccumulator {
  private buffer = ''
  private content = ''
  private finishReason: string | null = null
  private usage: TokenUsage | null = null
  private readonly toolCalls = new Map<number, PartialToolCall>()
  private readonly announced = new Set<number>()
  private done = false

  constructor(private readonly handlers: StreamHandlers = {}) {}

  /** Feeds one raw text chunk; safe to call with partial frames. */
  push(chunk: string): void {
    this.buffer += chunk
    // Frames are separated by a blank line. Tolerate CRLF from proxies.
    const normalized = this.buffer.replace(/\r\n/g, '\n')
    const frames = normalized.split('\n\n')
    // The trailing element may be an incomplete frame; keep it buffered.
    this.buffer = frames.pop() ?? ''
    for (const frame of frames) this.consumeFrame(frame)
  }

  /** Flushes any frame left without a trailing blank line. */
  finish(): StreamResult {
    if (this.buffer.trim().length > 0) {
      this.consumeFrame(this.buffer)
      this.buffer = ''
    }
    return this.result()
  }

  /** True once `[DONE]` was seen. */
  get isDone(): boolean {
    return this.done
  }

  result(): StreamResult {
    const toolCalls = [...this.toolCalls.values()]
      .sort((a, b) => a.index - b.index)
      .map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      }))
    return {
      content: this.content,
      toolCalls,
      finishReason: this.finishReason,
      usage: this.usage,
    }
  }

  /**
   * Extracts usage from a payload in either the OpenAI shape
   * (`usage.prompt_tokens` / `completion_tokens` / `total_tokens`, with
   * `prompt_tokens_details.cached_tokens`) or common variants used by
   * OpenAI-compatible gateways. Returns null when absent.
   */
  private extractUsage(parsed: unknown): TokenUsage | null {
    if (!parsed || typeof parsed !== 'object') return null
    const u = (parsed as { usage?: Record<string, unknown> }).usage
    if (!u || typeof u !== 'object') return null
    const num = (key: string): number | undefined => {
      const v = (u as Record<string, unknown>)[key]
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined
    }
    const inputTokens =
      num('prompt_tokens') ??
      num('input_tokens') ??
      num('inputTokens') ??
      num('promptTokens')
    const outputTokens =
      num('completion_tokens') ??
      num('output_tokens') ??
      num('outputTokens') ??
      num('completionTokens')
    if (inputTokens === undefined && outputTokens === undefined) return null
    // cached_tokens lives under prompt_tokens_details (OpenAI) or
    // cache_read_input_tokens (Anthropic-style gateways).
    const details = u.prompt_tokens_details as Record<string, unknown> | undefined
    const cachedInputTokens =
      (details && typeof details.cached_tokens === 'number'
        ? details.cached_tokens
        : undefined) ??
      num('cached_tokens') ??
      num('cachedTokens') ??
      num('cache_read_input_tokens') ??
      num('cacheReadInputTokens')
    const reasoningTokens =
      (details &&
      typeof details.reasoning_tokens === 'number'
        ? details.reasoning_tokens
        : undefined) ?? num('reasoning_tokens') ?? num('reasoningTokens')
    const totalTokens =
      num('total_tokens') ??
      num('totalTokens') ??
      ((inputTokens ?? 0) + (outputTokens ?? 0))
    return {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      ...(cachedInputTokens ? { cachedInputTokens } : {}),
      ...(reasoningTokens ? { reasoningTokens } : {}),
      totalTokens,
    }
  }

  private consumeFrame(frame: string): void {
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.trim()
      if (line.length === 0 || line.startsWith(':')) continue
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') {
        this.done = true
        continue
      }
      this.consumePayload(payload)
    }
  }

  private consumePayload(payload: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      // A malformed frame must not abort an otherwise good stream.
      return
    }

    // The trailing chunk often carries only usage with no choices.
    const extracted = this.extractUsage(parsed)
    if (extracted) {
      this.usage = extracted
      this.handlers.onUsage?.(extracted)
    }

    const choice = (parsed as { choices?: unknown[] }).choices?.[0] as
      | { delta?: Record<string, unknown>; finish_reason?: string | null }
      | undefined
    if (!choice) return // usage-only trailing chunk

    if (typeof choice.finish_reason === 'string') this.finishReason = choice.finish_reason

    const delta = choice.delta
    if (!delta) return

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      this.content += delta.content
      this.handlers.onText?.(delta.content)
    }

    const deltaToolCalls = delta.tool_calls
    if (!Array.isArray(deltaToolCalls)) return
    for (const raw of deltaToolCalls) {
      const fragment = raw as {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }
      const index = typeof fragment.index === 'number' ? fragment.index : 0
      const existing =
        this.toolCalls.get(index) ?? { index, id: '', name: '', arguments: '' }
      if (fragment.id) existing.id = fragment.id
      if (fragment.function?.name) existing.name = fragment.function.name
      if (typeof fragment.function?.arguments === 'string') {
        existing.arguments += fragment.function.arguments
      }
      this.toolCalls.set(index, existing)
      if (existing.name && !this.announced.has(index)) {
        this.announced.add(index)
        this.handlers.onToolCallStart?.(existing.name)
      }
    }
  }
}

export interface StreamRequest {
  apiKey: string
  baseUrl: string
  model: string
  messages: WireMessage[]
  tools?: WireTool[]
  /** Extra headers required by some gateways. */
  headers?: Record<string, string>
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** Provider name, used only to make error messages legible. */
  providerLabel?: string
}

/** Raised with a human-readable message for any non-2xx or transport failure. */
export class LlmError extends Error {}

/** Builds the request headers, letting profile headers override nothing critical. */
function buildHeaders(request: {
  apiKey: string
  headers?: Record<string, string>
}): Record<string, string> {
  return {
    ...(request.headers ?? {}),
    'Content-Type': 'application/json',
    Authorization: `Bearer ${request.apiKey}`,
  }
}

/**
 * Streams one completion.
 *
 * @throws {LlmError} on a missing key, an unreachable endpoint, a non-2xx
 *   response, or a body-less response, carrying the API's own `error.message`
 *   when it supplied one.
 */
export async function streamCompletion(
  request: StreamRequest,
  handlers: StreamHandlers = {},
): Promise<StreamResult> {
  const who = request.providerLabel ?? 'The model provider'

  if (!request.apiKey.trim()) {
    throw new LlmError('No API key configured. Add one in Settings.')
  }
  const base = normalizeBaseUrl(request.baseUrl)
  if (!base) {
    throw new LlmError('No base URL configured. Add one in Settings.')
  }

  const url = `${base}/chat/completions`
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
  }
  if (request.tools && request.tools.length > 0) body.tools = request.tools
  // Omitted rather than defaulted, so the provider's own default applies.
  if (typeof request.temperature === 'number') body.temperature = request.temperature
  if (typeof request.maxTokens === 'number') body.max_tokens = request.maxTokens

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(request),
      body: JSON.stringify(body),
      signal: request.signal,
    })
  } catch (error) {
    // Rethrow cancellation untouched so callers can distinguish it from failure.
    if ((error as Error)?.name === 'AbortError') throw error
    throw new LlmError(
      `Cannot reach ${url}: ${describeError(error)}. Check the base URL, your network, and whether the endpoint allows browser-extension requests.`,
    )
  }

  if (!response.ok) throw new LlmError(await describeHttpFailure(response, who))
  if (!response.body) throw new LlmError(`${who} returned an empty response body.`)

  const accumulator = new SseAccumulator(handlers)
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) accumulator.push(value)
      if (accumulator.isDone) break
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return accumulator.finish()
}

/**
 * Lists the models an endpoint advertises via `GET {baseUrl}/models`.
 *
 * Optional in practice: some gateways omit it, and Ark returns endpoint IDs
 * rather than model names, so the UI treats the result as a convenience list
 * and never as a constraint on what may be typed.
 */
export async function listModels(request: {
  apiKey: string
  baseUrl: string
  headers?: Record<string, string>
  signal?: AbortSignal
}): Promise<string[]> {
  const base = normalizeBaseUrl(request.baseUrl)
  if (!base) throw new LlmError('No base URL configured.')
  const url = `${base}/models`

  let response: Response
  try {
    response = await fetch(url, { headers: buildHeaders(request), signal: request.signal })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new LlmError(`Cannot reach ${url}: ${describeError(error)}`)
  }
  if (!response.ok) throw new LlmError(await describeHttpFailure(response, 'The provider'))

  const payload = (await response.json()) as { data?: { id?: unknown }[] }
  if (!Array.isArray(payload.data)) {
    throw new LlmError('The endpoint did not return a model list.')
  }
  return payload.data
    .map((entry) => (typeof entry.id === 'string' ? entry.id : ''))
    .filter((id) => id.length > 0)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Verifies a profile end to end with a minimal non-streaming request.
 *
 * Deliberately exercises the real `chat/completions` path with the configured
 * model, because a valid key and a usable model are separate failures: `/models`
 * succeeding proves nothing about whether this model name is accepted.
 */
export async function testConnection(request: {
  apiKey: string
  baseUrl: string
  model: string
  headers?: Record<string, string>
  signal?: AbortSignal
}): Promise<void> {
  const base = normalizeBaseUrl(request.baseUrl)
  if (!base) throw new LlmError('No base URL configured.')
  const url = `${base}/chat/completions`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(request),
      body: JSON.stringify({
        model: request.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: request.signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new LlmError(`Cannot reach ${url}: ${describeError(error)}`)
  }
  if (!response.ok) throw new LlmError(await describeHttpFailure(response, 'The provider'))
}

/**
 * Turns a failed response into an actionable message.
 *
 * Status codes carry consistent meaning across OpenAI-compatible vendors, so
 * they are mapped generically and the vendor's own `error.message` is appended
 * for the specifics.
 */
async function describeHttpFailure(response: Response, who: string): Promise<string> {
  let detail = ''
  try {
    const text = await response.text()
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string } | string
        message?: string
      }
      const fromError =
        typeof parsed.error === 'string' ? parsed.error : parsed.error?.message
      detail = fromError ?? parsed.message ?? text.slice(0, 300)
    } catch {
      detail = text.slice(0, 300)
    }
  } catch {
    detail = ''
  }
  const suffix = detail ? `: ${detail}` : ''

  switch (response.status) {
    case 401:
    case 403:
      return `${who} rejected the API key (${response.status})${suffix}`
    case 402:
      return `${who} reports insufficient balance or an inactive plan (402)${suffix}`
    case 404:
      return `${who} has no such endpoint or model (404). Check the base URL and the model name${suffix}`
    case 429:
      return `${who} rate limit or quota reached (429)${suffix}`
    default:
      return `${who} request failed (${response.status} ${response.statusText})${suffix}`
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
