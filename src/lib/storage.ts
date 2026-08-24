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
import type {
  ConversationMeta,
  HistoryEntry,
  PasswordEntry,
  SecretField,
  Settings,
  Skill,
  UserProfile,
} from './types'

const KEY_SCHEMA = 'schemaVersion'
const KEY_SETTINGS = 'settings'
const KEY_SKILLS = 'skills'
const KEY_PROFILES = 'profiles'
const KEY_PASSWORDS = 'passwords'
const KEY_HISTORY = 'history'
const KEY_CONVERSATIONS_META = 'conversations'

/**
 * Storage schema version.
 *
 * - v1: provider profiles plus an active pointer, a locale, and skills.
 * - v2: user profiles, password vault, action history, persistent
 *   conversations (messages moved to `storage.local`).
 */
export const SCHEMA_VERSION = 2

export const DEFAULT_SETTINGS: Settings = {
  providers: [],
  activeProviderId: '',
  locale: 'auto',
  mode: 'semi',
  maxToolRounds: 20,
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

/** Bounds for the configurable tool-round cap. */
export const MIN_TOOL_ROUNDS = 1
export const MAX_TOOL_ROUNDS_CAP = 100

/**
 * Clamps the configured tool-round limit to a sane integer range. A value too
 * low makes multi-step tasks impossible; too high lets a looping model burn
 * tokens and act on the page for far too long before being stopped.
 */
export function coerceMaxToolRounds(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.maxToolRounds
  return Math.min(MAX_TOOL_ROUNDS_CAP, Math.max(MIN_TOOL_ROUNDS, Math.round(n)))
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
    mode: value.mode === 'readonly' || value.mode === 'full' ? value.mode : 'semi',
    maxToolRounds: coerceMaxToolRounds(value.maxToolRounds),
  }
}

/**
 * Stamps the schema version and normalizes stored settings when needed.
 *
 * Runs on install and update, so a corrupted or partial record is repaired once
 * rather than being re-checked on every read path.
 */
export async function ensureSchema(): Promise<void> {
  const stored = await chrome.storage.local.get([
    KEY_SCHEMA,
    KEY_SETTINGS,
    KEY_PROFILES,
    KEY_PASSWORDS,
    KEY_HISTORY,
    KEY_CONVERSATIONS_META,
  ])
  if (stored[KEY_SCHEMA] === SCHEMA_VERSION) return

  const patch: Record<string, unknown> = {
    [KEY_SCHEMA]: SCHEMA_VERSION,
    [KEY_SETTINGS]: normalizeStoredSettings(stored[KEY_SETTINGS]),
  }
  // Seed new collections as empty arrays so reads never need to special-case
  // "key absent".
  if (!Array.isArray(stored[KEY_PROFILES])) patch[KEY_PROFILES] = []
  if (!Array.isArray(stored[KEY_PASSWORDS])) patch[KEY_PASSWORDS] = []
  if (!Array.isArray(stored[KEY_HISTORY])) patch[KEY_HISTORY] = []
  if (!Array.isArray(stored[KEY_CONVERSATIONS_META])) patch[KEY_CONVERSATIONS_META] = []
  await chrome.storage.local.set(patch)
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
 * Conversation history lives in `chrome.storage.local`, not session storage.
 *
 * Earlier versions kept the transcript in `storage.session`, which cleared on
 * browser exit. Durable local storage lets the user resume a thread days
 * later — what they expect from a "chat history" feature. Messages are
 * trimmed to {@link MAX_STORED_MESSAGES} so a long thread cannot grow without
 * bound.
 *
 * Tool/assistant content may include page text; it never leaves this machine
 * except as part of a model request.
 */
const CONVERSATION_PREFIX = 'conv:'

/**
 * The default conversation id. A fixed id makes collapse-and-return resume
 * the same thread without the panel having to coordinate a random id across
 * reconnects.
 */
export const DEFAULT_CONVERSATION_ID = 'default'

/** Status of a turn, so a reopened panel can tell whether work is still running. */
export interface TurnState {
  conversationId: string
  running: boolean
  error?: string
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
  const stored = await chrome.storage.local.get(key)
  const value = stored[key]
  return Array.isArray(value) ? (value as WireMessage[]) : []
}

/** Persists a conversation, trimmed via {@link trimConversation}. */
export async function saveConversation(
  conversationId: string,
  messages: WireMessage[],
): Promise<void> {
  await chrome.storage.local.set({
    [conversationKey(conversationId)]: trimConversation(messages),
  })
}

export async function clearConversation(conversationId: string): Promise<void> {
  await chrome.storage.local.remove(conversationKey(conversationId))
}

// --- Conversation metadata --------------------------------------------------

const DEFAULT_CONVERSATION_TITLE = 'New conversation'

function asMeta(value: unknown): ConversationMeta | null {
  if (!value || typeof value !== 'object') return null
  const meta = value as ConversationMeta
  if (typeof meta.id !== 'string') return null
  return {
    id: meta.id,
    title: typeof meta.title === 'string' && meta.title ? meta.title : DEFAULT_CONVERSATION_TITLE,
    createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : Date.now(),
    updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : Date.now(),
    preview: typeof meta.preview === 'string' ? meta.preview : undefined,
  }
}

export async function listConversations(): Promise<ConversationMeta[]> {
  const stored = await chrome.storage.local.get(KEY_CONVERSATIONS_META)
  const list = stored[KEY_CONVERSATIONS_META]
  if (!Array.isArray(list)) return []
  return list
    .map(asMeta)
    .filter((meta): meta is ConversationMeta => meta !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getConversationMeta(
  conversationId: string,
): Promise<ConversationMeta | undefined> {
  return (await listConversations()).find((meta) => meta.id === conversationId)
}

/**
 * Touches a conversation's metadata, creating it on first message.
 *
 * `title` is derived from the first user message and never overwritten, so
 * the user can rename a thread without the next turn clobbering it.
 */
export async function touchConversation(
  conversationId: string,
  firstUserText?: string,
): Promise<ConversationMeta> {
  const list = await listConversations()
  const existing = list.find((meta) => meta.id === conversationId)
  const now = Date.now()
  if (existing) {
    existing.updatedAt = now
    if (firstUserText && (!existing.preview || existing.preview.trim().length === 0)) {
      existing.preview = firstUserText.slice(0, 120)
    }
    if (
      firstUserText &&
      (!existing.title || existing.title === DEFAULT_CONVERSATION_TITLE)
    ) {
      existing.title = firstUserText.trim().slice(0, 60) || DEFAULT_CONVERSATION_TITLE
    }
    await chrome.storage.local.set({ [KEY_CONVERSATIONS_META]: list })
    return existing
  }
  const trimmed = firstUserText?.trim() ?? ''
  const created: ConversationMeta = {
    id: conversationId,
    title: (trimmed.slice(0, 60) || DEFAULT_CONVERSATION_TITLE),
    createdAt: now,
    updatedAt: now,
    preview: trimmed.slice(0, 120) || undefined,
  }
  list.push(created)
  await chrome.storage.local.set({ [KEY_CONVERSATIONS_META]: list })
  return created
}

export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<void> {
  const list = await listConversations()
  const meta = list.find((entry) => entry.id === conversationId)
  if (meta) {
    meta.title = title.trim().slice(0, 80) || DEFAULT_CONVERSATION_TITLE
    meta.updatedAt = Date.now()
    await chrome.storage.local.set({ [KEY_CONVERSATIONS_META]: list })
  }
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const [metaList] = await Promise.all([
    chrome.storage.local.get(KEY_CONVERSATIONS_META),
    clearConversation(conversationId),
  ])
  const list = Array.isArray(metaList[KEY_CONVERSATIONS_META])
    ? (metaList[KEY_CONVERSATIONS_META] as ConversationMeta[])
    : []
  await chrome.storage.local.set({
    [KEY_CONVERSATIONS_META]: list.filter((meta) => meta.id !== conversationId),
  })
  // Also drop turn state and any history for this thread.
  await chrome.storage.session.remove(`${TURN_STATE_PREFIX}${conversationId}`)
  const all = await listHistory()
  await chrome.storage.local.set({
    [KEY_HISTORY]: all.filter((entry) => entry.conversationId !== conversationId),
  })
}

// --- User profiles ----------------------------------------------------------

function asProfile(value: unknown): UserProfile | null {
  if (!value || typeof value !== 'object') return null
  const profile = value as Partial<UserProfile>
  if (typeof profile.id !== 'string') return null
  const str = (input: unknown): string | undefined =>
    typeof input === 'string' ? input : undefined
  return {
    id: profile.id,
    label: str(profile.label) ?? 'Profile',
    fullName: str(profile.fullName),
    firstName: str(profile.firstName),
    lastName: str(profile.lastName),
    email: str(profile.email),
    phone: str(profile.phone),
    address: str(profile.address),
    city: str(profile.city),
    state: str(profile.state),
    postalCode: str(profile.postalCode),
    country: str(profile.country),
    company: str(profile.company),
    jobTitle: str(profile.jobTitle),
    custom:
      profile.custom && typeof profile.custom === 'object' && !Array.isArray(profile.custom)
        ? Object.fromEntries(
            Object.entries(profile.custom as Record<string, unknown>)
              .filter(([, v]) => typeof v === 'string')
              .map(([k, v]) => [k, v as string]),
          )
        : {},
    createdAt: typeof profile.createdAt === 'number' ? profile.createdAt : Date.now(),
    updatedAt: typeof profile.updatedAt === 'number' ? profile.updatedAt : Date.now(),
  }
}

export async function listProfiles(): Promise<UserProfile[]> {
  const stored = await chrome.storage.local.get(KEY_PROFILES)
  const list = stored[KEY_PROFILES]
  if (!Array.isArray(list)) return []
  return list
    .map(asProfile)
    .filter((profile): profile is UserProfile => profile !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  const list = await listProfiles()
  const index = list.findIndex((entry) => entry.id === profile.id)
  const normalized: UserProfile = { ...profile, updatedAt: Date.now() }
  if (index === -1) list.push(normalized)
  else list[index] = normalized
  await chrome.storage.local.set({ [KEY_PROFILES]: list })
}

export async function deleteProfile(id: string): Promise<void> {
  const list = await listProfiles()
  await chrome.storage.local.set({
    [KEY_PROFILES]: list.filter((profile) => profile.id !== id),
  })
}

// --- Password vault ---------------------------------------------------------

function asPassword(value: unknown): PasswordEntry | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as PasswordEntry
  if (typeof entry.id !== 'string') return null

  // Accept both the new `fields[]` shape and legacy single password. A legacy
  // entry is valid as long as it has a password string; new entries only need
  // a label (fields can be edited in afterwards).
  const hasFields = Array.isArray(entry.fields) && entry.fields.length > 0
  const hasLegacy = typeof entry.password === 'string'
  if (!hasFields && !hasLegacy && typeof entry.label !== 'string') return null

  const fields: SecretField[] = hasFields
    ? entry.fields
        .filter((f) => f && typeof f.key === 'string')
        .map((f) => ({ key: f.key, value: String(f.value ?? ''), ...(f.secret ? { secret: true } : {}) }))
    : hasLegacy
      ? [
          ...(entry.username ? [{ key: 'username', value: String(entry.username) }] : []),
          { key: 'password', value: entry.password as string, secret: true },
          ...(entry.notes ? [{ key: 'notes', value: String(entry.notes) }] : []),
        ]
      : []

  return {
    id: entry.id,
    label: typeof entry.label === 'string' && entry.label ? entry.label : 'Credential',
    ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
    fields,
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
    useCount: typeof entry.useCount === 'number' ? entry.useCount : 0,
    lastUsedAt: typeof entry.lastUsedAt === 'number' ? entry.lastUsedAt : undefined,
  }
}

export async function listPasswords(): Promise<PasswordEntry[]> {
  const stored = await chrome.storage.local.get(KEY_PASSWORDS)
  const list = stored[KEY_PASSWORDS]
  if (!Array.isArray(list)) return []
  return list
    .map(asPassword)
    .filter((entry): entry is PasswordEntry => entry !== null)
    .sort((a, b) => {
      if (!!b.lastUsedAt !== !!a.lastUsedAt) return b.lastUsedAt ? 1 : -1
      if (b.lastUsedAt && a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt
      return b.updatedAt - a.updatedAt
    })
}

export async function savePassword(entry: PasswordEntry): Promise<void> {
  const list = await listPasswords()
  const index = list.findIndex((existing) => existing.id === entry.id)
  // Normalise: keep only well-formed fields, drop empty keys, and never persist
  // the deprecated legacy columns once an entry is in the new shape.
  const fields = (entry.fields ?? [])
    .filter((f) => f && f.key.trim() !== '')
    .map((f) => ({ key: f.key.trim(), value: f.value, ...(f.secret ? { secret: true } : {}) }))
  const normalized: PasswordEntry = {
    id: entry.id,
    label: entry.label?.trim() || 'Credential',
    ...(entry.url?.trim() ? { url: entry.url.trim() } : {}),
    fields,
    createdAt: entry.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    useCount: entry.useCount ?? 0,
    ...(typeof entry.lastUsedAt === 'number' ? { lastUsedAt: entry.lastUsedAt } : {}),
  }
  if (index === -1) list.push(normalized)
  else list[index] = normalized
  await chrome.storage.local.set({ [KEY_PASSWORDS]: list })
}

export async function deletePassword(id: string): Promise<void> {
  const list = await listPasswords()
  await chrome.storage.local.set({
    [KEY_PASSWORDS]: list.filter((entry) => entry.id !== id),
  })
}

/** Bumps use counters so the most-used credentials surface first. */
export async function recordPasswordUse(id: string): Promise<void> {
  const list = await listPasswords()
  const entry = list.find((item) => item.id === id)
  if (entry) {
    entry.useCount += 1
    entry.lastUsedAt = Date.now()
    await chrome.storage.local.set({ [KEY_PASSWORDS]: list })
  }
}

// --- Action history ---------------------------------------------------------

/** Hard cap so the audit log cannot grow without bound. */
export const MAX_HISTORY_ENTRIES = 500

function asHistory(value: unknown): HistoryEntry | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as HistoryEntry
  if (typeof entry.id !== 'string' || typeof entry.action !== 'string') return null
  return {
    id: entry.id,
    at: typeof entry.at === 'number' ? entry.at : Date.now(),
    conversationId:
      typeof entry.conversationId === 'string' ? entry.conversationId : DEFAULT_CONVERSATION_ID,
    action: entry.action,
    summary: typeof entry.summary === 'string' ? entry.summary : '',
    host: typeof entry.host === 'string' ? entry.host : undefined,
    approved: entry.approved !== false,
    ok: entry.ok !== false,
    detail: Array.isArray(entry.detail)
      ? entry.detail.filter((d): d is string => typeof d === 'string')
      : undefined,
  }
}

export async function listHistory(): Promise<HistoryEntry[]> {
  const stored = await chrome.storage.local.get(KEY_HISTORY)
  const list = stored[KEY_HISTORY]
  if (!Array.isArray(list)) return []
  return list
    .map(asHistory)
    .filter((entry): entry is HistoryEntry => entry !== null)
    .sort((a, b) => b.at - a.at)
}

export async function addHistory(entry: HistoryEntry): Promise<void> {
  const list = await listHistory()
  list.unshift(entry)
  // listHistory sorts by time; cap the newest N.
  const trimmed = list.slice(0, MAX_HISTORY_ENTRIES)
  await chrome.storage.local.set({ [KEY_HISTORY]: trimmed })
}

export async function deleteHistory(id: string): Promise<void> {
  const list = await listHistory()
  await chrome.storage.local.set({
    [KEY_HISTORY]: list.filter((entry) => entry.id !== id),
  })
}

export async function clearHistory(): Promise<void> {
  await chrome.storage.local.set({ [KEY_HISTORY]: [] })
}
