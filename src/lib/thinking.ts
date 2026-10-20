/**
 * Vendor-neutral thinking-effort control for OpenAI-compatible endpoints.
 *
 * Every vendor spells thinking control differently — a flat `reasoning_effort`
 * (OpenAI, Groq, xAI, Kimi, MiniMax), a nested `reasoning.effort`
 * (OpenRouter), a nested `thinking` object (DeepSeek, Ark), a boolean plus a
 * token budget (DashScope, SiliconFlow), or a bare `thinking.type` (GLM) — and
 * each accepts a different set of levels. The panel therefore offers only four
 * neutral levels, and this module holds the per-vendor translation table that
 * turns one of them into request-body fields.
 *
 * The table is DATA, not branches: a new vendor is one more entry, and a
 * vendor whose shape could not be confirmed from its own documentation is
 * marked `verified: false` so the UI can say "cannot confirm" instead of
 * claiming support. Model-level support stays unknowable from here — a
 * provider's 400 is the ground truth (see {@link isUnsupportedThinkingDetail}).
 *
 * @module lib/thinking
 */

/** Neutral thinking-effort levels the panel offers. */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

/** Levels in display order: off first, then increasing effort. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high']

/**
 * Wire parameter names that carry thinking control.
 *
 * Matched loosely (case-insensitive, separators ignored) because vendors spell
 * the same field differently in their error messages: Aliyun reports
 * `InvalidParameter.NotSupportEnableThinking`, OpenAI reports
 * `Unsupported parameter: 'reasoning_effort'`.
 */
export const THINKING_PARAM_NAMES: readonly string[] = ['reasoning_effort', 'reasoning', 'thinking']

/** Vendors whose thinking-control shape this module knows. */
export type ThinkingVendor =
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'ark'
  | 'dashscope'
  | 'zhipu'
  | 'kimi'
  | 'minimax'
  | 'siliconflow'
  | 'groq'
  | 'xai'
  | 'unknown'

/** How one vendor expresses thinking control. */
export interface VendorThinking {
  /**
   * Levels the panel may offer for this vendor. A level missing here is one
   * the vendor cannot express at all (Kimi has no "off", GLM has no levels) —
   * those are hidden rather than shown as a fake option.
   */
  levels: readonly ThinkingLevel[]
  /**
   * Level → request-body fragment. Every level has an entry so a stored value
   * that a later vendor switch made inexpressible still sends something
   * sensible; an empty object means "this vendor cannot express it, send
   * nothing".
   */
  body: Record<ThinkingLevel, Record<string, unknown>>
  /** Whether the shape comes from the vendor's own documentation. */
  verified: boolean
}

/**
 * Per-vendor translation table.
 *
 * Sources are the vendors' own API references, quoted in
 * `specs/2026-10-20-thinking-effort-design.md` §2.4. Levels the vendor cannot
 * express exactly are mapped to its nearest equivalent, which is what the
 * vendors themselves document (DeepSeek folds `medium`/`xhigh` into `high`).
 */
const VENDOR_THINKING: Record<ThinkingVendor, VendorThinking> = {
  openai: {
    levels: ['off', 'low', 'medium', 'high'],
    verified: true,
    body: {
      off: { reasoning_effort: 'none' },
      low: { reasoning_effort: 'low' },
      medium: { reasoning_effort: 'medium' },
      high: { reasoning_effort: 'high' },
    },
  },
  openrouter: {
    levels: ['off', 'low', 'medium', 'high'],
    verified: true,
    body: {
      off: { reasoning: { effort: 'none' } },
      low: { reasoning: { effort: 'low' } },
      medium: { reasoning: { effort: 'medium' } },
      high: { reasoning: { effort: 'high' } },
    },
  },
  deepseek: {
    levels: ['off', 'low', 'high'],
    verified: true,
    body: {
      off: { thinking: { type: 'disabled' } },
      low: { thinking: { type: 'enabled', reasoning_effort: 'low' } },
      medium: { thinking: { type: 'enabled', reasoning_effort: 'high' } },
      high: { thinking: { type: 'enabled', reasoning_effort: 'high' } },
    },
  },
  ark: {
    levels: ['off', 'low', 'medium', 'high'],
    verified: true,
    body: {
      off: { thinking: { type: 'disabled' } },
      low: { reasoning: { effort: 'low' } },
      medium: { reasoning: { effort: 'medium' } },
      high: { reasoning: { effort: 'high' } },
    },
  },
  dashscope: {
    levels: ['off', 'low', 'medium', 'high'],
    verified: true,
    body: {
      off: { enable_thinking: false },
      low: { enable_thinking: true, thinking_budget: 1024 },
      medium: { enable_thinking: true, thinking_budget: 4096 },
      high: { enable_thinking: true, thinking_budget: 16384 },
    },
  },
  zhipu: {
    levels: ['off', 'high'],
    verified: true,
    body: {
      off: { thinking: { type: 'disabled' } },
      low: { thinking: { type: 'enabled' } },
      medium: { thinking: { type: 'enabled' } },
      high: { thinking: { type: 'enabled' } },
    },
  },
  kimi: {
    // K3 documents low/high/max and no way to turn thinking off.
    levels: ['low', 'medium', 'high'],
    verified: true,
    body: {
      off: {},
      low: { reasoning_effort: 'low' },
      medium: { reasoning_effort: 'high' },
      high: { reasoning_effort: 'max' },
    },
  },
  minimax: {
    levels: ['off', 'low', 'medium', 'high'],
    verified: true,
    body: {
      off: { thinking: { type: 'disabled' } },
      low: { reasoning_effort: 'low' },
      medium: { reasoning_effort: 'medium' },
      high: { reasoning_effort: 'high' },
    },
  },
  siliconflow: {
    levels: ['off', 'low', 'medium', 'high'],
    verified: true,
    body: {
      off: { enable_thinking: false },
      low: { enable_thinking: true, thinking_budget: 1024 },
      medium: { enable_thinking: true, thinking_budget: 4096 },
      high: { enable_thinking: true, thinking_budget: 16384 },
    },
  },
  groq: {
    // Groq documents low/medium/high, with no level that turns reasoning off.
    levels: ['low', 'medium', 'high'],
    verified: true,
    body: {
      off: {},
      low: { reasoning_effort: 'low' },
      medium: { reasoning_effort: 'medium' },
      high: { reasoning_effort: 'high' },
    },
  },
  xai: {
    // xAI documents low/medium/high and states reasoning cannot be disabled.
    levels: ['low', 'medium', 'high'],
    verified: true,
    body: {
      off: {},
      low: { reasoning_effort: 'low' },
      medium: { reasoning_effort: 'medium' },
      high: { reasoning_effort: 'high' },
    },
  },
  unknown: {
    levels: ['off', 'low', 'medium', 'high'],
    verified: false,
    body: {
      off: { reasoning_effort: 'none' },
      low: { reasoning_effort: 'low' },
      medium: { reasoning_effort: 'medium' },
      high: { reasoning_effort: 'high' },
    },
  },
}

/**
 * Models documented NOT to support thinking control.
 *
 * Deliberately tiny: a wrong entry here silently disables a working setting,
 * which is worse than the "cannot confirm" answer the unknown case gives.
 */
const UNSUPPORTED_MODELS: Partial<Record<ThinkingVendor, RegExp[]>> = {
  // OpenAI documents reasoning_effort for the o series and gpt-5 only.
  openai: [/^gpt-4o/, /^chatgpt-4o/, /^gpt-4\.1/, /^gpt-4-turbo/, /^gpt-3\.5/],
  // DeepSeek documents thinking for deepseek-reasoner only.
  deepseek: [/^deepseek-chat/],
}

/** Models documented to support thinking control. */
const SUPPORTED_MODELS: Partial<Record<ThinkingVendor, RegExp[]>> = {
  openai: [/^o\d/, /^gpt-5/],
  deepseek: [/^deepseek-reasoner/],
  ark: [/^doubao-seed/, /^glm-5/],
  dashscope: [/^qwen3/],
  zhipu: [/^glm-4\.[7-9]/, /^glm-5/],
  kimi: [/^kimi-k3/],
  minimax: [/^minimax-m3/],
  groq: [/^openai\/gpt-oss-/],
  xai: [/^grok-4/],
}

/** What a provider is known to do with a thinking parameter. */
export type ThinkingModelSupport = 'supported' | 'unsupported' | 'unknown'

/** Hostname of a base URL, lowercased; empty when it cannot be parsed. */
function hostOf(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) return ''
  try {
    return new URL(
      /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    ).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * The vendor behind a base URL.
 *
 * Resolved from the host rather than from `ProviderProfile.presetId`: editing
 * the base URL flips the preset to `custom` even though the vendor is
 * unchanged, and the host is the stable signal.
 */
export function thinkingVendorOf(baseUrl: string): ThinkingVendor {
  const host = hostOf(baseUrl)
  if (!host) return 'unknown'
  if (host === 'api.openai.com') return 'openai'
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return 'openrouter'
  if (host.endsWith('.deepseek.com')) return 'deepseek'
  if (host.endsWith('.volces.com')) return 'ark'
  if (host.startsWith('dashscope') && host.endsWith('.aliyuncs.com')) return 'dashscope'
  if (host === 'open.bigmodel.cn' || host.endsWith('.bigmodel.cn')) return 'zhipu'
  if (host === 'api.z.ai') return 'zhipu'
  if (host.endsWith('.moonshot.cn') || host.endsWith('.moonshot.ai')) return 'kimi'
  if (host.endsWith('.kimi.com')) return 'kimi'
  if (host.endsWith('.minimaxi.com') || host.endsWith('.minimax.cn')) return 'minimax'
  if (host.endsWith('.minimax.chat')) return 'minimax'
  if (host.endsWith('.siliconflow.cn')) return 'siliconflow'
  if (host.endsWith('.groq.com')) return 'groq'
  if (host === 'api.x.ai') return 'xai'
  return 'unknown'
}

/** The levels a vendor can express, in display order. */
export function thinkingLevelsFor(baseUrl: string): readonly ThinkingLevel[] {
  return VENDOR_THINKING[thinkingVendorOf(baseUrl)].levels
}

/** Whether the vendor's shape is backed by its own documentation. */
export function thinkingShapeVerified(baseUrl: string): boolean {
  return VENDOR_THINKING[thinkingVendorOf(baseUrl)].verified
}

/**
 * What a model is known to do with a thinking parameter.
 *
 * Only two answers are ever asserted: a model documented to reject thinking
 * control, and a model documented to accept it. Everything else is `unknown` —
 * the provider's own 400 is the only trustworthy signal for the rest.
 */
export function thinkingModelSupport(baseUrl: string, model: string): ThinkingModelSupport {
  const vendor = thinkingVendorOf(baseUrl)
  const name = model.trim().toLowerCase()
  if (!name) return 'unknown'
  if (UNSUPPORTED_MODELS[vendor]?.some((pattern) => pattern.test(name))) return 'unsupported'
  if (SUPPORTED_MODELS[vendor]?.some((pattern) => pattern.test(name))) return 'supported'
  return 'unknown'
}

/**
 * The request-body fragment for a thinking level, or undefined when nothing
 * should be sent.
 *
 * Nothing is sent when the level is unset (the provider's own default
 * applies) and nothing is sent for a model documented to reject thinking
 * control — sending it there would fail every request.
 */
export function thinkingBodyFor(
  baseUrl: string,
  model: string,
  level: ThinkingLevel | undefined,
): Record<string, unknown> | undefined {
  if (!level) return undefined
  if (thinkingModelSupport(baseUrl, model) === 'unsupported') return undefined
  const fragment = VENDOR_THINKING[thinkingVendorOf(baseUrl)].body[level]
  if (!fragment || Object.keys(fragment).length === 0) return undefined
  return fragment
}

/**
 * A one-line description of the parameters a level sends, e.g.
 * `thinking.reasoning_effort=high` — so the user can check it against the
 * vendor's documentation.
 */
export function thinkingParamSummary(baseUrl: string, level: ThinkingLevel): string {
  const fragment = VENDOR_THINKING[thinkingVendorOf(baseUrl)].body[level]
  const parts: string[] = []
  for (const [key, value] of Object.entries(fragment ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
        parts.push(`${key}.${innerKey}=${String(innerValue)}`)
      }
      continue
    }
    parts.push(`${key}=${String(value)}`)
  }
  return parts.join(', ')
}

/** Normalizes a stored value to a legal level, or undefined when unusable. */
export function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined
}

/** A stored profile whose thinking level may be from another build. */
interface MaybeThinkingProfile {
  thinkingEffort?: unknown
}

/**
 * A profile whose thinking level this build understands.
 *
 * A hand-edited or downgraded record must not break the panel, so a level
 * this build does not know is treated as "not set" instead of being passed
 * through to the request builder.
 */
export function normalizeThinkingProfile<T extends MaybeThinkingProfile>(profile: T): T {
  const level = normalizeThinkingLevel(profile.thinkingEffort)
  if (level === profile.thinkingEffort) return profile
  const { thinkingEffort: _dropped, ...rest } = profile
  return (level === undefined ? rest : { ...rest, thinkingEffort: level }) as T
}

/**
 * Whether a provider error says the request carried a parameter the model
 * does not accept.
 *
 * Only a 400/422 with a thinking parameter name and a rejection wording
 * counts. A message about a value being out of range (a thinking budget that is
 * too large, a context window that is too small) is a different problem and
 * must not be reported as "this model has no thinking support".
 */
export function isUnsupportedThinkingDetail(detail: string): boolean {
  if (!detail) return false
  const normalized = detail.toLowerCase().replace(/[\s_.-]/g, '')
  if (
    /(mustbebetween|outofrange|toolarge|toosmall|exceeds|maximum|minimum|greaterthan|lessthan)/.test(
      normalized,
    )
  ) {
    return false
  }
  const mentionsParam = THINKING_PARAM_NAMES.some((name) =>
    normalized.includes(name.replace(/[_.]/g, '')),
  )
  if (!mentionsParam) return false
  return /(unsupported|notsupported|unrecognized|unknown|unexpected|invalid|notallow|doesnotsupport|notpermit)/.test(
    normalized,
  )
}
