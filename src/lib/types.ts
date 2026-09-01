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
   * 已设置下载目录时，直接把工作流产生的文件保存到该目录而不询问；关闭（或无目录）时询问用户保存位置。
   */
  downloadAutoSave: boolean
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
