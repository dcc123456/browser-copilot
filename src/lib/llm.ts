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

import { isImageAttachment, isTextAttachment } from './attachments'
import type { AttachmentDescriptor } from './attachments'
import { normalizeBaseUrl } from './providers'
import { isUnsupportedThinkingDetail, thinkingBodyFor, type ThinkingLevel } from './thinking'
import type { TokenAttribution } from './token-ledger'

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

/**
 * One content part of a multimodal user message, in the OpenAI-compatible
 * wire format. Assembled from a turn's text plus its attachments by
 * {@link toApiMessages}; never stored in the transcript itself.
 */
export type UserContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export type WireMessage =
  | { role: 'system'; content: string }
  | {
      role: 'user'
      content: string
      /**
       * Files attached to this turn, persisted with the transcript. Kept
       * alongside the plain-string `content` (not folded into it) so history
       * previews and replay stay cheap; {@link toApiMessages} folds them into
       * multimodal content parts when the request is built.
       */
      attachments?: AttachmentDescriptor[]
      /**
       * What the UI should show as this turn's user text — the raw message the
       * user actually sent. `content` may carry model-only envelopes (the
       * active-skill directive, a captured page selection) that must never be
       * rendered back as if the user had typed them. Display-only: stripped by
       * {@link toApiMessages} so providers never receive it.
       */
      displayContent?: string
    }
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

/**
 * Result content for a tool call that never ran: the user pressed Stop between
 * the assistant turn and its execution (see `runAgentTurn`'s abort guards), or
 * the stream died mid-call. Model-facing only — the synthetic turn is built
 * here, at request time, so the persisted transcript keeps the real
 * interrupted state the panel showed the user.
 */
const INTERRUPTED_TOOL_RESULT =
  '[No result: this call was interrupted before it ran. Do not assume it happened.]'

/**
 * Model-facing envelope for a supplement the user typed while a turn ran.
 *
 * The user's own words are never rewritten — they stay the transcript's spine and
 * what the panel shows back through `displayContent`. But a bare user turn
 * landing mid-task reads to some models as a brand-new request, which would make
 * it abandon the work in flight. The wrapper states which one it is: keep going,
 * apply this to the task already running.
 */
export function wrapInterjection(note: string): string {
  return [
    '[Supplement to the task already in progress: keep going with the current plan and apply this to the work in flight. Do not restart the task, and do not treat this as a new request.]',
    `User supplement: ${note}`,
  ].join('\n')
}

/** A truncated stream can hand back half a JSON object; providers re-parse it. */
function isParsableArguments(value: string): boolean {
  if (value.trim() === '') return true
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

/**
 * Make every `tool_calls` turn in a transcript self-contained.
 *
 * The transcript is one mutable array whose turn persists whatever it holds
 * (the `finally` around `saveConversation`), so an interrupted full-auto run
 * can leave an assistant `tool_calls` turn with no matching `role: 'tool'`
 * result — or with results for only the first k calls. Providers reject that
 * shape outright, and because the broken turn stays stored, every later request
 * in the conversation fails the same way. Called by {@link toApiMessages}, the
 * one place requests are built, so all hosts (extension, runner, unattended,
 * delegation) are covered and an already-poisoned transcript heals on the next
 * send.
 *
 * Exported for direct testing.
 */
export function closeInterruptedToolRounds(messages: readonly WireMessage[]): WireMessage[] {
  type ToolTurn = Extract<WireMessage, { role: 'tool' }>
  const closed: WireMessage[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message || message.role !== 'assistant' || !message.tool_calls?.length) {
      // A `tool` result sitting here has no owning assistant turn — its
      // `tool_calls` turn was dropped by trimming, or it never existed.
      if (message && message.role !== 'tool') closed.push(message)
      continue
    }
    const advertised = message.tool_calls
    // `SseAccumulator` can emit a call with an empty id; such a call can never
    // be paired, so it goes rather than poisoning the request.
    const calls = advertised
      .filter((call) => call.id !== '')
      .map((call) =>
        isParsableArguments(call.function.arguments)
          ? call
          : { ...call, function: { ...call.function, arguments: '{}' } },
      )
    // Results for one turn are always contiguous — the agent loop pushes them
    // right after the assistant turn — so consume the whole run and re-emit it
    // in call order, dropping duplicates and results for calls that were cut.
    const run: ToolTurn[] = []
    const resultsById = new Map<string, ToolTurn>()
    let cursor = index + 1
    while (cursor < messages.length) {
      const following = messages[cursor]
      if (!following || following.role !== 'tool') break
      run.push(following)
      if (!resultsById.has(following.tool_call_id))
        resultsById.set(following.tool_call_id, following)
      cursor += 1
    }
    index = cursor - 1
    // Repair only what is broken: an intact round keeps its own objects by
    // reference, so a healthy transcript is sent exactly as it was stored.
    const intact =
      calls.length === advertised.length &&
      calls.every((repairedCall, position) => repairedCall === advertised[position]) &&
      message.content !== null &&
      run.length === calls.length &&
      run.every((answered, position) => answered.tool_call_id === calls[position]?.id)
    if (intact) {
      closed.push(message, ...run)
      continue
    }
    if (calls.length === 0) {
      closed.push({ role: 'assistant', content: message.content ?? '' })
      continue
    }
    closed.push({ ...message, content: message.content ?? '', tool_calls: calls })
    for (const call of calls) {
      closed.push(
        resultsById.get(call.id) ?? {
          role: 'tool',
          tool_call_id: call.id,
          content: INTERRUPTED_TOOL_RESULT,
          name: call.function.name,
        },
      )
    }
  }
  return closed
}

/**
 * Maps stored transcript messages to the request body's `messages` array.
 *
 * User turns with attachments become multimodal content parts: the typed text
 * first (when non-empty), then each image as an `image_url` data URL and each
 * text file inlined as a labelled fenced block. Extension-internal fields
 * (`attachments`, `displayContent`) are always stripped so providers never see
 * fields they did not ask for. Tool-call pairing is repaired first by
 * {@link closeInterruptedToolRounds}.
 */
export function toApiMessages(messages: readonly WireMessage[]): unknown[] {
  return closeInterruptedToolRounds(messages).map((message) => {
    if (message.role !== 'user') return message
    if (!message.attachments || message.attachments.length === 0) {
      // Rebuild the plain pair: displayContent must never reach the provider.
      return { role: 'user', content: message.content }
    }
    const parts: UserContentPart[] = []
    if (message.content.trim().length > 0) {
      parts.push({ type: 'text', text: message.content })
    }
    const shedNames: string[] = []
    for (const attachment of message.attachments) {
      if (isImageAttachment(attachment)) {
        // Narrowed by isImageAttachment; asserted for the discriminated union.
        parts.push({ type: 'image_url', image_url: { url: attachment.dataUrl as string } })
      } else if (isTextAttachment(attachment)) {
        // Four backticks: content containing a normal ``` fence cannot break out.
        parts.push({
          type: 'text',
          text: `[Attachment: ${attachment.name}]\n\`\`\`\`\n${attachment.content}\n\`\`\`\``,
        })
      } else if (attachment.mimeType.startsWith('image/')) {
        // An image whose bytes the persist budget dropped (see `lib/storage`).
        shedNames.push(attachment.name)
      }
    }
    if (parts.length === 0 && shedNames.length > 0) {
      // An empty content array is only ever produced here for an attachment the
      // provider cannot see; say what is missing rather than send a turn with no
      // content, which some providers reject outright.
      parts.push({
        type: 'text',
        text: `[Image attachment no longer available: ${shedNames.join(', ')}]`,
      })
    }
    return { role: 'user', content: parts }
  })
}

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

/**
 * Who is being retried, and whether the next attempt continues the reply that
 * already started streaming.
 */
export interface StreamRetryInfo {
  /** 1-based retry number about to be waited for (the retry, not the failure). */
  retry: number
  /** Total retries the caller allowed. */
  retries: number
  /** How long the client will wait before the next attempt. */
  delayMs: number
  /** True when the next request asks the model to continue where it stopped. */
  continuing: boolean
  /** The failure that triggered the retry, for logging and UI copy. */
  message: string
}

/**
 * Caller-owned retry budget.
 *
 * Omitted → the provider-wide default (3 attempts, exponential backoff) and a
 * stream that dies AFTER text has been delivered stays terminal. Set → the
 * wait between attempts is fixed, and a partial reply is resumed by
 * continuation (see {@link streamCompletion}).
 */
export interface StreamRetryPolicy {
  /** Additional requests after the first one fails (10 = 1 initial + 10). */
  retries: number
  delayMs: number
}

/** Terminal result of one streamed completion. */
export interface StreamResult {
  content: string
  /** Chain-of-thought text the provider streamed separately from the answer. */
  reasoning: string
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
  /**
   * Fired before every automatic retry. `continuing` says the next attempt
   * resumes the partial reply instead of restarting it, so a host can tell the
   * user "reconnecting, picking up where it stopped" rather than "retrying".
   */
  onRetry?: (info: StreamRetryInfo) => void
  /**
   * Chain-of-thought deltas from reasoning models (DeepSeek / Qwen / Ark
   * `reasoning_content`). Kept separate from `onText` so a provider's
   * thinking is never mistaken for the answer, and never folded into the
   * persisted transcript.
   */
  onReasoning?: (delta: string) => void
}

/**
 * Extracts usage from a payload in either the OpenAI shape
 * (`usage.prompt_tokens` / `completion_tokens` / `total_tokens`, with
 * `prompt_tokens_details.cached_tokens`) or common variants used by
 * OpenAI-compatible gateways. Returns null when absent.
 *
 * Exported because non-streaming calls (the vision model) read the same object
 * off a plain JSON body — one parse rule for the whole project, so streaming
 * and one-shot usage can never be accounted with different semantics.
 */
export function extractUsage(parsed: unknown): TokenUsage | null {
  if (!parsed || typeof parsed !== 'object') return null
  const u = (parsed as { usage?: Record<string, unknown> }).usage
  if (!u || typeof u !== 'object') return null
  const num = (key: string): number | undefined => {
    const v = (u as Record<string, unknown>)[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  const inputTokens =
    num('prompt_tokens') ?? num('input_tokens') ?? num('inputTokens') ?? num('promptTokens')
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
    (details && typeof details.cached_tokens === 'number' ? details.cached_tokens : undefined) ??
    num('cached_tokens') ??
    num('cachedTokens') ??
    num('cache_read_input_tokens') ??
    num('cacheReadInputTokens')
  const reasoningTokens =
    (details && typeof details.reasoning_tokens === 'number'
      ? details.reasoning_tokens
      : undefined) ??
    num('reasoning_tokens') ??
    num('reasoningTokens')
  const totalTokens =
    num('total_tokens') ?? num('totalTokens') ?? (inputTokens ?? 0) + (outputTokens ?? 0)
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cachedInputTokens ? { cachedInputTokens } : {}),
    ...(reasoningTokens ? { reasoningTokens } : {}),
    totalTokens,
  }
}

/** One observed completion's worth of usage, with the attribution it carries. */
export interface UsageEvent {
  attribution: TokenAttribution
  model: string
  usage: TokenUsage
}

/**
 * Host-installed sink for {@link UsageEvent}s. The transport layer stays
 * chrome-free and knows nothing about storage: the service worker installs a
 * sink that writes the token ledger, the runner installs one that writes its
 * own file. Setting it to `null` disables accounting.
 */
export type UsageObserver = (event: UsageEvent) => void

let usageObserver: UsageObserver | null = null

export function setUsageObserver(observer: UsageObserver | null): void {
  usageObserver = observer
}

/**
 * Reports one request's usage. Only attributed requests are observed — an
 * omitted attribution means the caller has not been wired up yet, which is
 * exactly the gap the token dashboard was built to close, so it stays loud in
 * the code rather than silently defaulting to some other bucket.
 */
export function observeUsage(
  request: { attribution?: TokenAttribution; model: string },
  usage: TokenUsage,
): void {
  if (!usageObserver || !request.attribution) return
  try {
    usageObserver({ attribution: request.attribution, model: request.model, usage })
  } catch (error) {
    // Accounting is a side channel: a broken sink must never fail a model call
    // the user is waiting on.
    console.warn('[llm] usage observer failed', error)
  }
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
  private reasoning = ''
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

  /**
   * How many tool calls this stream announced. A failed attempt with any call
   * in flight cannot be continued — half a JSON argument list is not a call.
   */
  get toolCallCount(): number {
    return this.toolCalls.size
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
      reasoning: this.reasoning,
      toolCalls,
      finishReason: this.finishReason,
      usage: this.usage,
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

    // A provider that fails mid-reply reports it as a frame, not as an HTTP
    // status. Ignoring it turned "the model errored" into "the answer simply
    // stopped" — no error, no retry, half a reply. Surfacing it as transient
    // lets the caller reconnect and continue.
    const providerError = (parsed as { error?: unknown }).error
    if (providerError) {
      const message =
        typeof providerError === 'string'
          ? providerError
          : typeof (providerError as { message?: unknown }).message === 'string'
            ? (providerError as { message: string }).message
            : JSON.stringify(providerError)
      throw new LlmError(`Provider error mid-stream: ${message}`, { transient: true })
    }

    // The trailing chunk often carries only usage with no choices.
    const extracted = extractUsage(parsed)
    if (extracted) {
      this.usage = extracted
      this.handlers.onUsage?.(extracted)
    }

    const choice = (parsed as { choices?: unknown[] }).choices?.[0] as
      { delta?: Record<string, unknown>; finish_reason?: string | null } | undefined
    if (!choice) return // usage-only trailing chunk

    if (typeof choice.finish_reason === 'string') this.finishReason = choice.finish_reason

    const delta = choice.delta
    if (!delta) return

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      this.content += delta.content
      this.handlers.onText?.(delta.content)
    }

    // Reasoning models stream their thinking as `reasoning_content` alongside
    // an empty `content`. Surfaced separately so it can render live without
    // polluting the answer or the persisted transcript.
    const reasoningDelta = (delta as Record<string, unknown>)['reasoning_content']
    if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
      this.reasoning += reasoningDelta
      this.handlers.onReasoning?.(reasoningDelta)
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
      const existing = this.toolCalls.get(index) ?? { index, id: '', name: '', arguments: '' }
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
  /**
   * Thinking effort. Omitted → the provider's own default applies; the vendor
   * decides which parameters carry it (see `src/lib/thinking.ts`).
   */
  thinking?: ThinkingLevel
  signal?: AbortSignal
  /** Provider name, used only to make error messages legible. */
  providerLabel?: string
  /**
   * What this request's tokens should be charged to. Optional so a caller can
   * be wired up incrementally, but every feature that reaches the dashboard
   * must supply it — the ledger's completeness claim is exactly this field.
   */
  attribution?: TokenAttribution
  /**
   * Caller-owned retry budget. Chat turns pass 10 retries at a fixed 5s so a
   * dropped stream reconnects and continues instead of ending the turn.
   */
  retry?: StreamRetryPolicy
  /**
   * Abort an attempt after this long with no text/reasoning delta. A silent
   * connection is indistinguishable from a slow first token, so a total cap
   * punishes thinking models; only the gap between deltas is bounded here. Each
   * attempt gets its own watchdog, and the abort reads as a transient failure
   * (TimeoutError, not AbortError), so the retry policy sees it as a cut.
   */
  idleTimeoutMs?: number
}

/**
 * HTTP statuses worth retrying: request timeout, rate limit, and 5xx. A retry
 * can only help for these — 4xx client errors (bad key, bad model) are
 * permanent, so retrying them would just burn quota.
 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])

/** Max attempts (1 initial + 2 retries) for a transient failure. */
export const LLM_MAX_ATTEMPTS = 3

/** Base backoff before the first retry; doubles per attempt (with jitter). */
const RETRY_BASE_MS = 500

/** Upper bound on a single backoff wait. */
const RETRY_MAX_MS = 8000

/** A failed HTTP response, described in a way the caller can act on. */
interface HttpFailure {
  message: string
  code?: 'unsupported-thinking'
}

/**
 * Raised with a human-readable message for any non-2xx or transport failure.
 *
 * `transient` marks a failure a retry may resolve (429 / 5xx / network);
 * `status` carries the HTTP status when the failure came from a response.
 * {@link streamCompletion} already retries transient failures internally, so
 * callers only see a transient error after the attempts are exhausted.
 */
export class LlmError extends Error {
  readonly status?: number
  readonly transient: boolean
  /**
   * Machine-readable failure kind, for callers that localize the message
   * themselves. The message stays English because this module is shared with
   * the Runner, which has no locale.
   */
  readonly code?: 'unsupported-thinking'
  constructor(
    message: string,
    options: { status?: number; transient?: boolean; code?: 'unsupported-thinking' } = {},
  ) {
    super(message)
    this.name = 'LlmError'
    this.status = options.status
    this.transient =
      options.transient ?? (options.status !== undefined && RETRYABLE_STATUS.has(options.status))
    this.code = options.code
  }
}

/** True when retrying the failed request may succeed (429 / 5xx / network). */
export function isTransientLlmError(error: unknown): boolean {
  return error instanceof LlmError && error.transient
}

/** Exponential backoff with full jitter, capped at {@link RETRY_MAX_MS}. */
function retryBackoffMs(attempt: number): number {
  const base = RETRY_BASE_MS * 2 ** (attempt - 1)
  return Math.min(base + Math.random() * RETRY_BASE_MS, RETRY_MAX_MS)
}

/** Sleeps, rejecting with an AbortError when the signal fires mid-wait. */
function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Aborts after `ms` without a {@link touch}, and restarts the clock on each
 * touch. The reason is a TimeoutError rather than an AbortError so the retry
 * path treats a silent connection as transient, while a user cancel still ends
 * the call immediately.
 */
function createIdleWatchdog(ms: number): {
  signal: AbortSignal
  touch: () => void
  dispose: () => void
} {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const touch = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      controller.abort(
        new DOMException(`No output for ${Math.round(ms / 1000)} seconds.`, 'TimeoutError'),
      )
    }, ms)
  }
  touch()
  return {
    signal: controller.signal,
    touch,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

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
 * Appended as a user turn when a reply was cut mid-transmission. The partial
 * answer rides in the preceding assistant message, so the instruction only has
 * to stop the model from restarting or repeating it.
 */
const STREAM_CONTINUE_PROMPT =
  '[The reply above was interrupted mid-transmission. Continue from exactly where it stopped: do not repeat any text already written, do not restart the answer, and do not mention the interruption.]'

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
  const baseMessages = toApiMessages(request.messages)
  const body: Record<string, unknown> = {
    model: request.model,
    messages: baseMessages,
    stream: true,
    // Providers omit per-chunk usage unless the client asks for it; without
    // this the panel's token statistics stay at zero for the whole stream.
    stream_options: { include_usage: true },
  }
  if (request.tools && request.tools.length > 0) body.tools = request.tools
  // Omitted rather than defaulted, so the provider's own default applies.
  if (typeof request.temperature === 'number') body.temperature = request.temperature
  if (typeof request.maxTokens === 'number') body.max_tokens = request.maxTokens
  // Which parameters carry the effort depends on the vendor, and a model
  // documented to reject thinking control gets nothing sent at all.
  const thinking = thinkingBodyFor(request.baseUrl, request.model, request.thinking)
  if (thinking) Object.assign(body, thinking)

  const doFetch = (
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: buildHeaders(request),
      body: JSON.stringify(payload),
      signal,
    })

  /**
   * Sends one request, negotiating away `stream_options` once when a strict
   * gateway rejects it with 400 — losing usage stats beats losing the reply.
   * This is format negotiation, not a retry: it does not consume an attempt.
   */
  const sendRequest = async (
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    let response = await doFetch(payload, signal)
    if (!response.ok && response.status === 400 && 'stream_options' in payload) {
      const { stream_options: _dropped, ...withoutUsage } = payload
      response = await doFetch(withoutUsage, signal)
    }
    return response
  }

  const policy = request.retry
  // Without a policy this function keeps its historical contract: up to 3
  // attempts for transient failures with exponential backoff, and a failure
  // AFTER the body started streaming is terminal (there is nowhere to resume).
  const maxRetries = policy ? Math.max(0, Math.floor(policy.retries)) : LLM_MAX_ATTEMPTS - 1
  const attempts = maxRetries + 1

  // Text already streamed to the caller across attempts. A retry with this
  // non-empty resumes from it; the final content is this plus the last
  // attempt's own output.
  let delivered = ''
  let reasoning = ''
  let lastUsage: TokenUsage | null = null

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (request.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const continuing = delivered.length > 0
    // A reply that already started is continued, never replayed: resending the
    // original request would make the model answer the same question twice and
    // duplicate what the user already sees.
    const payload = continuing
      ? {
          ...body,
          messages: [
            ...baseMessages,
            { role: 'assistant', content: delivered },
            { role: 'user', content: STREAM_CONTINUE_PROMPT },
          ],
        }
      : body

    let accumulator: SseAccumulator | undefined
    let streaming = false
    // Every attempt gets its own watchdog: one aborted signal would poison all
    // later attempts, and a reply that already started deserves a full fresh
    // window. Only the gap between deltas is bounded, never the total call.
    const idle =
      typeof request.idleTimeoutMs === 'number' && request.idleTimeoutMs > 0
        ? createIdleWatchdog(request.idleTimeoutMs)
        : undefined
    const attemptSignal = idle
      ? request.signal
        ? AbortSignal.any([request.signal, idle.signal])
        : idle.signal
      : request.signal
    // Any visible output proves the connection is alive; reasoning counts, since
    // a thinking model may legitimately write no answer text for minutes.
    const attemptHandlers: StreamHandlers = idle
      ? {
          ...handlers,
          onText: (delta) => {
            idle.touch()
            handlers.onText?.(delta)
          },
          onReasoning: (delta) => {
            idle.touch()
            handlers.onReasoning?.(delta)
          },
        }
      : handlers
    try {
      const response = await sendRequest(payload, attemptSignal)
      if (!response.ok) {
        const failure = await describeHttpFailure(response, who)
        throw new LlmError(failure.message, {
          status: response.status,
          transient: RETRYABLE_STATUS.has(response.status),
          ...(failure.code ? { code: failure.code } : {}),
        })
      }
      if (!response.body) throw new LlmError(`${who} returned an empty response body.`)
      streaming = true

      // Every completion's usage passes through one hook, so attribution cannot
      // drift between features (see `observeUsage`). Each attempt reports its
      // own usage: a retried request was really billed.
      accumulator = new SseAccumulator({
        ...attemptHandlers,
        onUsage: (usage) => {
          lastUsage = usage
          observeUsage(request, usage)
          handlers.onUsage?.(usage)
        },
      })
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
      const result = accumulator.finish()

      // A clean close carrying neither `[DONE]` nor `finish_reason` is a cut
      // connection dressed up as a completed reply. Only callers that opted
      // into retrying get the heuristic; for everyone else partial content is
      // historically returned as-is.
      if (
        policy !== undefined &&
        !accumulator.isDone &&
        result.finishReason === null &&
        result.toolCalls.length === 0 &&
        (result.content.length > 0 || delivered.length > 0)
      ) {
        throw new LlmError('The model stream ended before the reply completed.', {
          transient: true,
        })
      }

      // The reply completed; silence after this point is not this request's.
      idle?.dispose()
      return {
        content: delivered + result.content,
        reasoning: reasoning + result.reasoning,
        toolCalls: result.toolCalls,
        finishReason: result.finishReason,
        // The last request is the one that measures the live context; summing
        // attempts would make the next turn believe the prompt is several
        // times larger and compact history it does not need to.
        usage: lastUsage,
      }
    } catch (error) {
      // Disarmed before anything else: this attempt's connection is gone, and
      // only the next attempt's own watchdog may cut it short.
      idle?.dispose()
      // Cancellation is never retried — callers distinguish it by name.
      if ((error as Error)?.name === 'AbortError') throw error
      const failure =
        error instanceof LlmError
          ? error
          : new LlmError(
              (error as Error)?.name === 'TimeoutError'
                ? `${who} stopped sending output: ${describeError(error)}`
                : `Cannot reach ${url}: ${describeError(error)}. Check the base URL, your network, and whether the endpoint allows browser-extension requests.`,
              { transient: true },
            )
      // Whatever this attempt managed to stream is already visible to the
      // user; carry it forward so the next request continues from it.
      const partial = accumulator?.result()
      delivered += partial?.content ?? ''
      reasoning += partial?.reasoning ?? ''
      // A half-announced tool call can never be resumed (its JSON arguments
      // may be cut mid-token), and a permanent failure will not heal.
      const resumable =
        (partial?.toolCalls.length ?? 0) === 0 &&
        failure.transient &&
        (policy !== undefined || !streaming)
      if (!resumable || attempt === attempts) throw failure

      const delayMs = policy ? policy.delayMs : retryBackoffMs(attempt)
      handlers.onRetry?.({
        retry: attempt,
        retries: maxRetries,
        delayMs,
        continuing: delivered.length > 0,
        message: failure.message,
      })
      await sleepWithSignal(delayMs, request.signal)
    }
  }
  // The loop either returns or throws on its last attempt; this only satisfies
  // the compiler.
  throw new LlmError(`${who} request failed.`)
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
  if (!response.ok) {
    const failure = await describeHttpFailure(response, 'The provider')
    throw new LlmError(failure.message, {
      status: response.status,
      ...(failure.code ? { code: failure.code } : {}),
    })
  }

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
  /** Thinking effort to exercise, so the probe can prove the model accepts it. */
  thinking?: ThinkingLevel
  /** Response cap; only used when a thinking effort is exercised. */
  maxTokens?: number
  signal?: AbortSignal
}): Promise<void> {
  const base = normalizeBaseUrl(request.baseUrl)
  if (!base) throw new LlmError('No base URL configured.')
  const url = `${base}/chat/completions`

  const body: Record<string, unknown> = {
    model: request.model,
    messages: [{ role: 'user', content: 'ping' }],
    stream: false,
  }
  const thinking = thinkingBodyFor(request.baseUrl, request.model, request.thinking)
  if (thinking) {
    Object.assign(body, thinking)
    // A reasoning model spends its cap on reasoning tokens, so a cap of 1 fails
    // for a reason that has nothing to do with the profile under test.
    if (typeof request.maxTokens === 'number') body.max_tokens = request.maxTokens
  } else {
    body.max_tokens = 1
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(request),
      body: JSON.stringify(body),
      signal: request.signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new LlmError(`Cannot reach ${url}: ${describeError(error)}`)
  }
  if (!response.ok) {
    const failure = await describeHttpFailure(response, 'The provider')
    throw new LlmError(failure.message, {
      status: response.status,
      ...(failure.code ? { code: failure.code } : {}),
    })
  }
}

/**
 * Turns a failed response into an actionable message.
 *
 * Status codes carry consistent meaning across OpenAI-compatible vendors, so
 * they are mapped generically and the vendor's own `error.message` is appended
 * for the specifics. A vendor that rejects a parameter the model does not
 * accept also gets a code, so the caller can explain the failure in the
 * user's language instead of showing the vendor's raw English.
 */
async function describeHttpFailure(response: Response, who: string): Promise<HttpFailure> {
  let detail = ''
  try {
    const text = await response.text()
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string } | string
        message?: string
      }
      const fromError = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message
      detail = fromError ?? parsed.message ?? text.slice(0, 300)
    } catch {
      detail = text.slice(0, 300)
    }
  } catch {
    detail = ''
  }
  const suffix = detail ? `: ${detail}` : ''
  const code: HttpFailure['code'] =
    (response.status === 400 || response.status === 422) && isUnsupportedThinkingDetail(detail)
      ? 'unsupported-thinking'
      : undefined

  if (code === 'unsupported-thinking') {
    return {
      message: `${who} rejected a request parameter this model does not support (${response.status})${suffix}`,
      code,
    }
  }

  switch (response.status) {
    case 401:
    case 403:
      return { message: `${who} rejected the API key (${response.status})${suffix}` }
    case 402:
      return { message: `${who} reports insufficient balance or an inactive plan (402)${suffix}` }
    case 404:
      return {
        message: `${who} has no such endpoint or model (404). Check the base URL and the model name${suffix}`,
      }
    case 429:
      return { message: `${who} rate limit or quota reached (429)${suffix}` }
    default:
      return {
        message: `${who} request failed (${response.status} ${response.statusText})${suffix}`,
      }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
