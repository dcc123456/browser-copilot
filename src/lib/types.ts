/**
 * Shared domain types for Browser Copilot.
 *
 * @module lib/types
 */

import type { LocaleSetting } from './i18n'
import type { ProviderProfile } from './providers'

export type { ProviderProfile }
export type { LocaleSetting }

/**
 * How autonomously the agent may act on a page.
 *
 * - `chat`: pure conversation. No operating rules and no tools are sent, so
 *   the request is just the user's messages — cheapest token cost, no page
 *   automation.
 * - `readonly`: only read tools; every action that changes the page is
 *   refused and reported back to the model.
 * - `semi`: read tools run as usual; every action requires the user's
 *   one-shot approval (the default).
 * - `full`: the agent may act without per-action confirmation. Reading a
 *   page still follows the attach consent rule, and all actions are still
 *   recorded in history.
 */
export type AgentMode = 'chat' | 'readonly' | 'semi' | 'full'

/**
 * A reusable instruction pack.
 */
export interface Skill {
  id: string
  /** Unique, human-chosen name; also how the agent refers to it. */
  name: string
  /** One line stating when the skill applies. Drives automatic matching. */
  description: string
  /** The instruction text appended to the system prompt while active. */
  instructions: string
  /** Whether the agent may select this skill on its own. */
  autoMatch: boolean
  createdAt: number
  updatedAt: number
}

/**
 * User settings.
 */
export interface Settings {
  providers: ProviderProfile[]
  /** Id of the profile the agent uses; empty when none is configured yet. */
  activeProviderId: string
  /** UI language. `'auto'` follows the browser's own language. */
  locale: LocaleSetting
  /** Agent autonomy mode. Defaults to `semi` (confirm each action). */
  mode: AgentMode
  /**
   * Maximum number of model↔tool round trips allowed in one turn before the
   * agent stops to avoid an infinite loop. Defaults to 20.
   */
  maxToolRounds: number
  /**
   * Tool names the user has turned OFF. Only names present here are withheld
   * from the model; everything else (including tools added in future versions)
   * stays available, so this behaves as a denylist and degrades gracefully.
   */
  disabledTools: string[]
  /**
   * User-edited base system prompt (the operating rules). An empty string means
   * use the built-in default; non-empty replaces the default rules verbatim.
   */
  systemPromptOverride: string
  /**
   * 对话页「保存工作流」开关。开启后对话 agent 走逐条执行的老路径（不使用
   * run_plan 批量执行），每个动作单独入历史，保证「从历史生成工作流」的
   * 算子节点完整。默认关闭（批量执行更快，内部步骤也会补录入历史）。
   */
  saveWorkflowFromChat: boolean
  /**
   * 已设置下载目录时，直接把工作流产生的文件保存到该目录而不询问；关闭（或无目录）时询问用户保存位置。
   */
  downloadAutoSave: boolean
  /**
   * 可选的独立图像识别/视觉模型（如 gpt-4o、qwen-vl、glm-4v），用于 `recognize_image`
   * 工具识别验证码等图片文字。留空时回退到当前激活的聊天 provider（若其支持视觉）。
   */
  imageModel: VisionConfig
  /**
   * 本地 OCR（Tesseract.js）使用的语言代码，`+` 连接可识别的多种语言，如
   * `eng`、`chi_sim`、`chi_sim+eng`。`recognize_image` 会先用本地 OCR 识别
   * （完全离线），结果为空或加载失败时再回退到视觉模型。
   */
  ocrLanguage: string
  /**
   * 是否启用“本地 Agent 接入”。开启后插件（service worker）作为 WebSocket
   * 客户端主动连接本机 agent 运行的服务端（见 {@link localAgentUrl}），让 agent
   * 无需知道扩展 ID 即可精确调用 click/fill 等单个工具。默认关闭。
   */
  localAgentEnabled: boolean
  /**
   * 可选的共享令牌。agent 发送的每个请求都必须携带相同的 token；
   * 留空表示不校验令牌。
   */
  localAgentToken: string
  /**
   * 本机 agent 的 WebSocket 服务端地址。仅允许 loopback 主机
   * （localhost / 127.0.0.1 / [::1]），其它地址会在归一化时回退到默认值。
   */
  localAgentUrl: string
  /**
   * 当前选中服务的 Agent 连接 id；`''` 表示服务所有连接（默认）。
   * 多个 agent 同时接入时，插件只执行被选中连接发来的 tool/prompt 请求，
   * 其余连接会被拒绝，从而实现“在插件里选择使用哪个连接”。
   */
  localAgentActiveAgent: string
  /**
   * 无人值守运行（agent 接入 / 定时任务 / 飞书任务）在多个插件窗口同时
   * 打开时如何选择目标窗口：
   * - `'latest'`（默认）：自动选最近使用的插件窗口；
   * - `'ask'`：在所有在线面板弹出窗口选择框（30 秒未选回退 latest）；
   * - `'fixed'`：固定 {@link unattendedWindowId}（失效自动回退 latest）。
   * 候选永远是“插件开着”（面板展开或最小化）的窗口；所有窗口都关闭插件时
   * 回退到无作用域的全局解析。
   */
  unattendedWindowPolicy: UnattendedWindowPolicy
  /** `unattendedWindowPolicy = 'fixed'` 时锁定的窗口 id；其余策略忽略。 */
  unattendedWindowId?: number
}

/** 无人值守运行的窗口选择策略（见 {@link Settings.unattendedWindowPolicy}）。 */
export type UnattendedWindowPolicy = 'latest' | 'ask' | 'fixed'

/** 本地 Agent 接入默认连接地址。 */
export const DEFAULT_LOCAL_AGENT_URL = 'ws://127.0.0.1:8765'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Coerces a stored `localAgentUrl` into a usable value: only `ws:`/`wss:` URLs
 * whose host is a loopback address are accepted; anything else (missing,
 * malformed, remote host, wrong scheme) falls back to the default.
 */
export function normalizeLocalAgentUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_LOCAL_AGENT_URL
  try {
    const url = new URL(value)
    if ((url.protocol === 'ws:' || url.protocol === 'wss:') && LOOPBACK_HOSTS.has(url.hostname)) {
      return value
    }
  } catch {
    // fall through to the default
  }
  return DEFAULT_LOCAL_AGENT_URL
}

/** 插件与本地 agent 之间 WebSocket 连接的状态。 */
export type AgentConnectionState = 'disconnected' | 'connecting' | 'connected'

/** 本地 Agent 接入的实时连接状态，供设置页展示。 */
export interface AgentStatus {
  /** 插件是否在目标 url 上建立了（或正在建立）连接。 */
  enabled: boolean
  /** 当前连接目标地址；未启用时为默认地址。 */
  url: string
  state: AgentConnectionState
  /** 最近一次失败/断开的原因（无错误时省略）。 */
  error?: string
  /** 最近一次连接成功的时间戳（毫秒）。 */
  connectedAt?: number
  /** 已接入的 Agent 连接列表（由适配器上报），供选择服务哪个连接。 */
  agents: AgentConnectionInfo[]
}

/** 一个已接入本地适配器的 Agent 连接。 */
export interface AgentConnectionInfo {
  /** 适配器实例生成的唯一 id。 */
  id: string
  /** 易读名称（默认 `agent-<id 前缀>`，可用环境变量指定）。 */
  name: string
}

/**
 * Selection of the optional image-recognition model.
 *
 * Instead of re-entering credentials, it references an already-configured chat
 * provider by id — that provider's base URL and API key are reused, and
 * `model` optionally overrides the model it was saved with. Kept optional so
 * non-vision default providers do not force the user to configure anything
 * unless they need captcha recognition.
 */
export interface VisionConfig {
  /** Provider id whose credentials are reused. Empty = resolve from the active provider. */
  providerId: string
  /** Optional model override; empty = use the selected provider's default model. */
  model: string
}

/** Text scraped from a tab, for use as agent context. */
export interface PageContext {
  url: string
  title: string
  selection: string
  text: string
  truncated: boolean
}

/** A chat message as rendered in the side panel. */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
}

// --- User profile / habit memory --------------------------------------------

/**
 * A user's personal profile used to pre-fill forms.
 *
 * Stored locally on this machine only. The agent reads these fields when a
 * form asks for matching information, so the user does not have to retype
 * their name, email, phone, or address on every site.
 */
export interface UserProfile {
  id: string
  /** Display label, e.g. "Personal" or "Work". */
  label: string
  fullName?: string
  firstName?: string
  lastName?: string
  email?: string
  phone?: string
  /** Free-form address block. */
  address?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
  company?: string
  jobTitle?: string
  /** Any extra key/value pairs the user wants available (e.g. "birthday"). */
  custom: Record<string, string>
  createdAt: number
  updatedAt: number
}

/**
 * A named secret bundle the agent can offer when filling forms.
 *
 * The user defines arbitrary key/value fields (e.g. "username" / "password" /
 * "card CVV" / "security answer") rather than a fixed username+password shape,
 * so a single entry can hold whatever credentials a site needs. Legacy entries
 * may still carry the deprecated `username`/`password`/`url`/`notes` fields;
 * those are migrated into `fields` on load and the agent's get_secret tool
 * understands the common keys.
 *
 * SECURITY: values are stored in `chrome.storage.local`, which is unencrypted
 * on disk and readable by anyone with access to the browser profile, exactly
 * like API keys. This is documented in the UI.
 */
export interface PasswordEntry {
  id: string
  /** Human label, e.g. "GitHub", "Work email". */
  label: string
  /** Optional URL/host this credential is associated with. */
  url?: string
  /** Arbitrary user-defined key/value pairs (the actual credentials). */
  fields: SecretField[]
  createdAt: number
  updatedAt: number
  /** Number of times the agent used this entry; surfaces frequent ones. */
  useCount: number
  lastUsedAt?: number

  /** Deprecated: superseded by `fields`. Retained for migration only. */
  username?: string
  /** Deprecated: superseded by `fields`. Retained for migration only. */
  password?: string
  /** Deprecated: superseded by `fields`. Retained for migration only. */
  notes?: string
}

/** One labelled key/value pair inside a {@link PasswordEntry}. */
export interface SecretField {
  key: string
  value: string
  /** When true, the UI masks the value like a password. */
  secret?: boolean
}

/** Migration helper: returns an entry's fields including any legacy columns. */
export function entryFields(entry: PasswordEntry): SecretField[] {
  const fields = Array.isArray(entry.fields) ? [...entry.fields] : []
  if (fields.length === 0) {
    if (entry.username) fields.push({ key: 'username', value: entry.username })
    if (entry.password) fields.push({ key: 'password', value: entry.password, secret: true })
    if (entry.notes) fields.push({ key: 'notes', value: entry.notes })
  }
  return fields
}

/** Finds a field value by name (case-insensitive); used by the agent tools. */
export function findField(entry: PasswordEntry, name: string): SecretField | undefined {
  const needle = name.toLowerCase()
  return entryFields(entry).find((field) => field.key.toLowerCase() === needle)
}

/**
 * A record of one agent-performed page action, kept for audit and so the
 * user can see exactly what the assistant did.
 */
export interface HistoryEntry {
  id: string
  /** Wall-clock ms. */
  at: number
  /** Conversation or task run this action belonged to. */
  conversationId: string
  /** Tool / action name. */
  action: string
  /** Human-readable summary shown in the History tab. */
  summary: string
  /** Host the action ran on, when applicable. */
  host?: string
  /** Whether the user had approved the action. */
  approved: boolean
  /** Ok/failed as reported by the driver. */
  ok: boolean
  /**
   * Extra detail line(s) for the audit view: e.g. the value typed into a field
   * (masked for secrets), the button/link label clicked, the option selected,
   * or the URL opened. One detail per array element, shown as sub-lines.
   */
  detail?: string[]
  /**
   * The raw tool args for this action. Retained so a full-auto session can be
   * rebuilt into a workflow afterwards.
   */
  args?: Record<string, unknown>
}

/**
 * Metadata for one conversation. The messages themselves live under a
 * separate storage key (see `storage.ts`).
 */
export interface ConversationMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** Last few words of the first user message, used as the title. */
  preview?: string
}
