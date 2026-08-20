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
 * A reusable instruction pack.
 *
 * Skills exist because the useful part of a prompt is usually stable ("summarise
 * like this", "extract these fields as JSON") while only the target changes. A
 * skill stores that stable part so it does not have to be retyped, and can be
 * applied either explicitly or by description match.
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
 *
 * Providers are a list plus an active pointer, so the user can keep several
 * endpoints configured (a coding-plan provider, a cheap fallback, a local model)
 * and switch without retyping credentials.
 */
export interface Settings {
  providers: ProviderProfile[]
  /** Id of the profile the agent uses; empty when none is configured yet. */
  activeProviderId: string
  /**
   * UI language. `'auto'` follows the browser's own language.
   *
   * Stored rather than derived so a user whose browser is in one language can
   * still read the panel in another.
   */
  locale: LocaleSetting
}

/** Text scraped from a tab, for use as agent context. */
export interface PageContext {
  url: string
  title: string
  /** Current selection, if any. */
  selection: string
  /** Visible body text, whitespace-collapsed. */
  text: string
  /** True when `text` hit the character budget. */
  truncated: boolean
}

/** A chat message as rendered in the side panel. */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  /** Present on tool messages, for display. */
  toolName?: string
}
