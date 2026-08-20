/**
 * Persistence. `chrome.storage.local` is the single source of truth: the MV3
 * service worker can be evicted between any two events, so no module-level
 * variable may hold state that matters.
 *
 * API keys live in `storage.local`, which is unencrypted on disk and readable by
 * anyone who can read the browser profile. `storage.sync` is deliberately
 * avoided so keys never leave this machine.
 *
 * @module lib/storage
 */

import { LOCALES, type LocaleSetting } from './i18n'
import type { WireMessage } from './llm'
import type { ProviderProfile } from './providers'
import type { Settings, Skill } from './types'

const KEY_SCHEMA = 'schemaVersion'
const KEY_SETTINGS = 'settings'
const KEY_SKILLS = 'skills'

/**
 * Storage schema version.
 *
 * - v1: provider profiles plus an active pointer, a locale, and skills.
 *
 * Stamped even though nothing needs migrating yet, because the alternative —
 * adding the marker later — leaves the first release's data indistinguishable
 * from an empty install.
 */
export const SCHEMA_VERSION = 1

export const DEFAULT_SETTINGS: Settings = {
  providers: [],
  activeProviderId: '',
  locale: 'auto',
}

/**
 * Accepts a stored locale value, falling back to `'auto'`.
 *
 * Validated rather than trusted because an unknown tag would otherwise reach the
 * dictionary lookup and render a panel full of blanks.
 */
function coerceLocale(value: unknown): LocaleSetting {
  if (value === 'auto') return 'auto'
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
    ? (value as LocaleSetting)
    : 'auto'
}

/**
 * Normalizes any stored settings value into the current shape.
 *
 * Storage is shared with a user who may have downgraded, hand-edited, or hit a
 * half-written record, so every field is validated rather than trusted. Exported
 * as a pure function so the rules are unit-testable without `chrome`.
 */
export function normalizeStoredSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS }

  const value = raw as Partial<Settings>

  const providers = Array.isArray(value.providers)
    ? value.providers.filter(
        (profile): profile is ProviderProfile =>
          !!profile && typeof profile === 'object' && typeof profile.id === 'string',
      )
    : []

  // Never leave the pointer dangling: an unknown id would open the editor blank
  // with no way to tell why.
  const active =
    typeof value.activeProviderId === 'string' &&
    providers.some((profile) => profile.id === value.activeProviderId)
      ? value.activeProviderId
      : (providers[0]?.id ?? '')

  return {
    providers,
    activeProviderId: active,
    locale: coerceLocale(value.locale),
  }
}

/**
 * Stamps the schema version and normalizes stored settings when needed.
 *
 * Runs on install and update, so a corrupted or partial record is repaired once
 * rather than being re-checked on every read path.
 */
export async function ensureSchema(): Promise<void> {
  const stored = await chrome.storage.local.get([KEY_SCHEMA, KEY_SETTINGS])
  if (stored[KEY_SCHEMA] === SCHEMA_VERSION) return

  await chrome.storage.local.set({
    [KEY_SCHEMA]: SCHEMA_VERSION,
    [KEY_SETTINGS]: normalizeStoredSettings(stored[KEY_SETTINGS]),
  })
}

/** Reads settings, normalizing whatever is on disk. */
export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY_SETTINGS)
  return normalizeStoredSettings(stored[KEY_SETTINGS])
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings()
  const merged: Settings = { ...current, ...patch }
  // Never leave the pointer dangling: a deleted or unknown active id falls back
  // to the first profile, so the agent always has a resolvable provider.
  if (!merged.providers.some((profile) => profile.id === merged.activeProviderId)) {
    merged.activeProviderId = merged.providers[0]?.id ?? ''
  }
  await chrome.storage.local.set({ [KEY_SETTINGS]: merged })
  return merged
}

/**
 * The provider the agent should use.
 *
 * @throws {Error} with setup guidance when nothing is configured, so the failure
 *   reaches the user as an instruction rather than a null dereference.
 */
export async function getActiveProvider(): Promise<ProviderProfile> {
  const settings = await getSettings()
  const active =
    settings.providers.find((profile) => profile.id === settings.activeProviderId) ??
    settings.providers[0]
  if (!active) {
    throw new Error(
      'No model provider configured. Open Settings and add one (DeepSeek, Volcengine Ark, or any OpenAI-compatible endpoint).',
    )
  }
  return active
}

/** Inserts or replaces one provider profile. */
export async function saveProvider(profile: ProviderProfile): Promise<Settings> {
  const settings = await getSettings()
  const providers = [...settings.providers]
  const index = providers.findIndex((existing) => existing.id === profile.id)
  if (index === -1) providers.push(profile)
  else providers[index] = profile
  // A first profile becomes active automatically; otherwise the choice stands.
  const activeProviderId = settings.activeProviderId || profile.id
  return setSettings({ providers, activeProviderId })
}

export async function deleteProvider(id: string): Promise<Settings> {
  const settings = await getSettings()
  const providers = settings.providers.filter((profile) => profile.id !== id)
  return setSettings({
    providers,
    activeProviderId:
      settings.activeProviderId === id ? (providers[0]?.id ?? '') : settings.activeProviderId,
  })
}

/** Collision-resistant id that does not depend on `crypto.randomUUID`. */
export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// --- Conversations -----------------------------------------------------------

/**
 * Conversation history lives in `chrome.storage.session`, not in a worker
 * variable.
 *
 * An MV3 service worker is evicted after roughly 30 seconds of inactivity, which
 * takes every in-memory `const history` with it. Keeping transcripts in session
 * storage means a reconnecting panel resumes the same conversation instead of
 * silently starting a new one. Session storage is memory-backed and cleared when
 * the browser closes, which is the right lifetime for a chat transcript — and it
 * keeps page text out of on-disk storage.
 */
const CONVERSATION_PREFIX = 'conv:'

/**
 * The single conversation id shared by every panel instance.
 *
 * Closing the panel destroys its JavaScript context, so a per-instance random id
 * would start a brand-new conversation on every reopen — exactly the data loss
 * this design exists to prevent. A fixed id makes "collapse the panel and come
 * back" resume the same thread.
 */
export const DEFAULT_CONVERSATION_ID = 'default'

/** Status of a turn, so a reopened panel can tell whether work is still running. */
export interface TurnState {
  conversationId: string
  /** True while the worker is streaming or running tools. */
  running: boolean
  /** Set when the last turn ended with an error. */
  error?: string
  /** Wall-clock ms of the last state change, for staleness checks. */
  at: number
}

const TURN_STATE_PREFIX = 'turn:'

export async function getTurnState(conversationId: string): Promise<TurnState | null> {
  const key = `${TURN_STATE_PREFIX}${conversationId}`
  const stored = await chrome.storage.session.get(key)
  const value = stored[key]
  return value && typeof value === 'object' ? (value as TurnState) : null
}

export async function setTurnState(state: TurnState): Promise<void> {
  await chrome.storage.session.set({
    [`${TURN_STATE_PREFIX}${state.conversationId}`]: state,
  })
}

// --- Skills ------------------------------------------------------------------

/**
 * Skills live in `storage.local`, not `storage.session`.
 *
 * They are authored deliberately and expected to persist, unlike transcripts. And
 * not in `storage.sync` — instruction text easily exceeds the 8 KB per-item sync
 * quota, which would fail silently once a user writes a detailed skill.
 */
export async function listSkills(): Promise<Skill[]> {
  const stored = await chrome.storage.local.get(KEY_SKILLS)
  const skills = stored[KEY_SKILLS]
  if (!Array.isArray(skills)) return []
  return skills.filter(
    (skill): skill is Skill =>
      !!skill &&
      typeof skill === 'object' &&
      typeof (skill as Skill).id === 'string' &&
      typeof (skill as Skill).name === 'string',
  )
}

export async function getSkill(id: string): Promise<Skill | undefined> {
  return (await listSkills()).find((skill) => skill.id === id)
}

/**
 * Finds a skill by name, case-insensitively.
 *
 * The agent refers to skills by name rather than id, since a generated id means
 * nothing to a model, and exact-case matching would make tool calls brittle.
 */
export async function findSkillByName(name: string): Promise<Skill | undefined> {
  const wanted = name.trim().toLowerCase()
  return (await listSkills()).find((skill) => skill.name.trim().toLowerCase() === wanted)
}

/** Inserts or replaces a skill, keeping the list sorted by name. */
export async function saveSkill(skill: Skill): Promise<void> {
  const skills = await listSkills()
  const index = skills.findIndex((existing) => existing.id === skill.id)
  if (index >= 0) skills[index] = skill
  else skills.push(skill)
  skills.sort((a, b) => a.name.localeCompare(b.name))
  await chrome.storage.local.set({ [KEY_SKILLS]: skills })
}

export async function deleteSkill(id: string): Promise<void> {
  const skills = (await listSkills()).filter((skill) => skill.id !== id)
  await chrome.storage.local.set({ [KEY_SKILLS]: skills })
}

/** Caps stored turns so a long session cannot grow unbounded. */
export const MAX_STORED_MESSAGES = 200

function conversationKey(conversationId: string): string {
  return `${CONVERSATION_PREFIX}${conversationId}`
}

/**
 * Trims a transcript to the newest {@link MAX_STORED_MESSAGES} turns.
 *
 * The retained window must never begin with a `tool` message: a tool result
 * whose originating `tool_calls` assistant turn was dropped makes providers
 * reject the entire request with a 400. Exported for direct testing.
 */
export function trimConversation(
  messages: WireMessage[],
  limit = MAX_STORED_MESSAGES,
): WireMessage[] {
  if (messages.length <= limit) return messages
  let start = messages.length - limit
  while (start < messages.length && messages[start]?.role === 'tool') start += 1
  return messages.slice(start)
}

/** Loads a conversation, returning an empty history when it is unknown. */
export async function loadConversation(conversationId: string): Promise<WireMessage[]> {
  const key = conversationKey(conversationId)
  const stored = await chrome.storage.session.get(key)
  const value = stored[key]
  return Array.isArray(value) ? (value as WireMessage[]) : []
}

/** Persists a conversation, trimmed via {@link trimConversation}. */
export async function saveConversation(
  conversationId: string,
  messages: WireMessage[],
): Promise<void> {
  await chrome.storage.session.set({
    [conversationKey(conversationId)]: trimConversation(messages),
  })
}

export async function clearConversation(conversationId: string): Promise<void> {
  await chrome.storage.session.remove(conversationKey(conversationId))
}
