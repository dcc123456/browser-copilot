/**
 * Provider profiles for any OpenAI-compatible chat-completions endpoint.
 *
 * Every supported vendor — DeepSeek, Volcengine Ark, OpenAI, OpenRouter, a local
 * Ollama or vLLM — speaks the same `POST {baseUrl}/chat/completions` protocol
 * with a `Bearer` token, SSE streaming, and `tools` function calling. So the
 * client needs no per-vendor code: a provider is just data (base URL, key,
 * model), and the presets below exist purely to spare the user from typing URLs.
 *
 * Verified 2026: both `https://api.deepseek.com/v1` and
 * `https://ark.cn-beijing.volces.com/api/v3` answer `/chat/completions` and
 * `/models`, and both return errors as `{ error: { message, ... } }`.
 *
 * @module lib/providers
 */

import { LOCALES, type LocaleSetting } from './i18n'
import type { AgentMode } from './types'

/** A configured endpoint the agent can talk to. */
export interface ProviderProfile {
  id: string
  /** User-facing name, e.g. "Ark coding plan". */
  label: string
  /** Which preset this was created from; `'custom'` once freely edited. */
  presetId: string
  /** Endpoint base. `/chat/completions` is appended. */
  baseUrl: string
  apiKey: string
  /**
   * Model or, on Ark, an endpoint ID (`ep-…`) when using a dedicated endpoint
   * rather than a shared model name.
   */
  model: string
  /** Extra headers some gateways require (e.g. OpenRouter attribution). */
  headers?: Record<string, string>
  /** Sampling temperature; omitted from the request when undefined. */
  temperature?: number
  /** Response cap; omitted when undefined so the server default applies. */
  maxTokens?: number
}

/** A starting point for a new profile. */
export interface ProviderPreset {
  id: string
  label: string
  baseUrl: string
  /** Suggested model, prefilled but always editable. */
  defaultModel: string
  /** Where to get a key, and any vendor-specific gotcha. */
  hint: string
  /** Docs URL for keys/models. */
  docsUrl?: string
}

/**
 * Known endpoints, in the order shown in the UI.
 *
 * `baseUrl` values deliberately include the version segment, because vendors
 * disagree about it (`/v1` vs `/api/v3`) and the client only ever appends
 * `/chat/completions`.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    hint: 'Create a key at platform.deepseek.com. Models: deepseek-chat, deepseek-reasoner.',
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'ark',
    label: '火山方舟 Volcengine Ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-code',
    hint: 'Use an Ark API key. For "model", use a model ID such as doubao-seed-code, or your dedicated endpoint ID (ep-…). A coding-plan subscription is billed against the model it covers.',
    docsUrl: 'https://console.volcengine.com/ark',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    hint: 'Create a key at platform.openai.com.',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-chat',
    hint: 'One key for many vendors. Model IDs are namespaced, e.g. deepseek/deepseek-chat.',
    docsUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'moonshot',
    label: 'Moonshot / Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2-0905-preview',
    hint: 'Create a key at platform.moonshot.cn.',
    docsUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼 DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    hint: 'Use the OpenAI-compatible base shown above, not the native DashScope path.',
    docsUrl: 'https://bailian.console.aliyun.com/',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    hint: 'Model IDs are namespaced, e.g. deepseek-ai/DeepSeek-V3.',
    docsUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen3:8b',
    hint: 'Runs locally; any non-empty key works. The model must already be pulled. Tool calling needs a model that supports it.',
    docsUrl: 'https://ollama.com/',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    hint: 'Start the local server in LM Studio first; any non-empty key works.',
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    baseUrl: '',
    defaultModel: '',
    hint: 'Any endpoint exposing POST {baseUrl}/chat/completions with Bearer auth. Enter the base URL up to but not including /chat/completions.',
  },
]

export function findPreset(presetId: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === presetId)
}

/**
 * Normalizes a base URL into the form the client expects.
 *
 * Users routinely paste the full endpoint from vendor docs, so a trailing
 * `/chat/completions` is stripped rather than producing a confusing 404 later.
 */
export function normalizeBaseUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '')
  url = url.replace(/\/chat\/completions$/i, '')
  return url.replace(/\/+$/, '')
}

/** Validation failure describing exactly which field is wrong. */
export interface ProfileProblem {
  field: 'label' | 'baseUrl' | 'apiKey' | 'model'
  message: string
}

/** Returns every problem with a profile, so a form can report them at once. */
export function validateProfile(profile: ProviderProfile): ProfileProblem[] {
  const problems: ProfileProblem[] = []

  if (!profile.label.trim()) {
    problems.push({ field: 'label', message: 'Give this provider a name.' })
  }

  const baseUrl = normalizeBaseUrl(profile.baseUrl)
  if (!baseUrl) {
    problems.push({ field: 'baseUrl', message: 'Base URL is required.' })
  } else if (!/^https?:\/\//i.test(baseUrl)) {
    problems.push({ field: 'baseUrl', message: 'Base URL must start with http:// or https://.' })
  } else {
    try {
      new URL(baseUrl)
    } catch {
      problems.push({ field: 'baseUrl', message: 'Base URL is not a valid URL.' })
    }
  }

  if (!profile.apiKey.trim()) {
    problems.push({ field: 'apiKey', message: 'API key is required.' })
  }
  if (!profile.model.trim()) {
    problems.push({ field: 'model', message: 'Model is required.' })
  }
  return problems
}

/** Builds a profile from a preset, ready to be edited. */
export function profileFromPreset(preset: ProviderPreset, id: string): ProviderProfile {
  return {
    id,
    label: preset.label,
    presetId: preset.id,
    baseUrl: preset.baseUrl,
    apiKey: '',
    model: preset.defaultModel,
  }
}

/**
 * Hosts that need no real credential.
 *
 * Local runtimes accept any bearer token, so the UI can prefill a placeholder
 * instead of demanding a key the user does not have.
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(normalizeBaseUrl(baseUrl))
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  } catch {
    return false
  }
}

/**
 * Coerces a settings payload received over the message channel into a renderable
 * shape.
 *
 * The panel and the service worker are separate bundles, and Chrome can have them
 * loaded at different versions — most visibly right after an update, when a stale
 * worker answers a fresh panel or vice versa. A missing `providers` array then
 * turns an expression like `settings.providers.length` into a
 * "Cannot read properties of undefined (reading 'length')" crash that unmounts
 * the whole panel, hiding the Settings tab needed to recover.
 *
 * Structural defaulting keeps the UI usable across that skew. Kept here, rather
 * than inline in the component, so it is unit-testable.
 */
export function normalizeSettingsPayload(raw: unknown): {
  providers: ProviderProfile[]
  activeProviderId: string
  locale: LocaleSetting
  mode: AgentMode
  maxToolRounds: number
  disabledTools: string[]
  systemPromptOverride: string
} {
  const value = (raw ?? {}) as Record<string, unknown>
  const providers = Array.isArray(value.providers)
    ? (value.providers as unknown[]).filter(
        (profile): profile is ProviderProfile =>
          !!profile && typeof profile === 'object' && typeof (profile as ProviderProfile).id === 'string',
      )
    : []
  const activeRaw = value.activeProviderId
  const activeProviderId = typeof activeRaw === 'string' ? activeRaw : ''
  const localeRaw = value.locale
  const modeRaw = value.mode
  const roundsRaw = value.maxToolRounds
  const rounds = typeof roundsRaw === 'number' ? roundsRaw : Number(roundsRaw)
  const maxToolRounds = Number.isFinite(rounds)
    ? Math.min(100, Math.max(1, Math.round(rounds)))
    : 20
  const disabledTools = Array.isArray(value.disabledTools)
    ? (value.disabledTools as unknown[]).filter((n): n is string => typeof n === 'string')
    : []
  const systemPromptOverride =
    typeof value.systemPromptOverride === 'string' ? value.systemPromptOverride : ''
  return {
    providers,
    // Never point at a profile that is not in the list, or the editor would open
    // blank with no way to tell why.
    activeProviderId: providers.some((profile) => profile.id === activeProviderId)
      ? activeProviderId
      : (providers[0]?.id ?? ''),
    // An unknown tag would render a panel full of blanks, so fall back to 'auto'.
    locale:
      localeRaw === 'auto' ||
      (typeof localeRaw === 'string' && (LOCALES as readonly string[]).includes(localeRaw))
        ? (localeRaw as LocaleSetting)
        : 'auto',
    mode:
      modeRaw === 'chat' || modeRaw === 'readonly' || modeRaw === 'full'
        ? (modeRaw as AgentMode)
        : 'semi',
    maxToolRounds,
    disabledTools,
    systemPromptOverride,
  }
}
