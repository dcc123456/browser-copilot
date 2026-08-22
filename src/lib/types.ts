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
 * - `readonly`: only read tools; every action that changes the page is
 *   refused and reported back to the model.
 * - `semi`: read tools run as usual; every action requires the user's
 *   one-shot approval (the default).
 * - `full`: the agent may act without per-action confirmation. Reading a
 *   page still follows the attach consent rule, and all actions are still
 *   recorded in history.
 */
export type AgentMode = 'readonly' | 'semi' | 'full'

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
 * A named secret the agent can offer when filling forms (passwords, card
 * security answers, etc.).
 *
 * SECURITY: values are stored in `chrome.storage.local`, which is unencrypted
 * on disk and readable by anyone with access to the browser profile, exactly
 * like API keys. This is documented in the UI. A future version may add a
 * passphrase-derived encryption layer; doing so without the user entering a
 * passphrase each session would provide no real protection, so the honest
 * baseline is local storage plus a clear warning.
 */
export interface PasswordEntry {
  id: string
  /** Human label, e.g. "GitHub", "Work email". */
  label: string
  /** Optional URL/host this credential is associated with. */
  url?: string
  username?: string
  password: string
  notes?: string
  createdAt: number
  updatedAt: number
  /** Number of times the agent used this entry; surfaces frequent ones. */
  useCount: number
  lastUsedAt?: number
}

/**
 * A record of one agent-performed page action, kept for audit and so the
 * user can see exactly what the assistant did.
 */
export interface HistoryEntry {
  id: string
  /** Wall-clock ms. */
  at: number
  /** Conversation this action belonged to. */
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
