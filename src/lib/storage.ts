/**
 * Persistence. Backed by real JSON files on the user's hard drive when a
 * storage directory is configured (see `lib/fs-store.ts`), with
 * `chrome.storage.local` as the mirror/fallback. Either way, the MV3 service
 * worker can be evicted between any two events, so no module-level variable may
 * hold state that matters.
 *
 * API keys live in the extension's storage (files / `storage.local`), which is
 * unencrypted on disk and readable by anyone who can read the browser profile.
 * `storage.sync` is deliberately avoided so keys never leave this machine.
 *
 * @module lib/storage
 */

import {
  FsDirectory,
  fileStorageArea,
  getGrantedFsDirectory,
  SKILLS_DIR,
  skillPath,
} from './fs-store'
import { skillFromMarkdown, skillSlug, skillToMarkdown } from './skills-import'
import { BUILT_IN_SKILLS } from './builtin-skills'
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
import { DEFAULT_LOCAL_AGENT_URL, normalizeLocalAgentUrl } from './types'
import type { Workflow, WorkflowEdge, WorkflowNode, WorkflowSettings } from './workflow/types'

/**
 * The active storage area: files when a directory is configured and granted,
 * otherwise the `chrome.storage.local` mirror.
 */
const area = fileStorageArea()

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
 * - v3: `imageModel` (optional vision config) added to settings; the
 *   built-in `skill-generator` skill is seeded on install/upgrade.
 */
export const SCHEMA_VERSION = 3

export const DEFAULT_SETTINGS: Settings = {
  providers: [],
  activeProviderId: '',
  locale: 'auto',
  mode: 'semi',
  maxToolRounds: 20,
  disabledTools: [],
  systemPromptOverride: '',
  saveWorkflowFromChat: false,
  downloadAutoSave: true,
  imageModel: { providerId: '', model: '' },
  ocrLanguage: 'eng',
  localAgentEnabled: false,
  localAgentToken: '',
  localAgentUrl: DEFAULT_LOCAL_AGENT_URL,
  localAgentActiveAgent: '',
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

  const rawImage = value.imageModel
  const imageModel =
    rawImage && typeof rawImage === 'object'
      ? {
          // New shape references a provider id; legacy shape stored credentials
          // directly, whose model (if any) we keep as an override.
          providerId: typeof rawImage.providerId === 'string' ? rawImage.providerId : '',
          model: typeof rawImage.model === 'string' ? rawImage.model : '',
        }
      : { ...DEFAULT_SETTINGS.imageModel }

  return {
    providers,
    activeProviderId: active,
    locale: coerceLocale(value.locale),
    mode:
      value.mode === 'chat' ||
      value.mode === 'readonly' ||
      value.mode === 'full'
        ? value.mode
        : 'semi',
    maxToolRounds: coerceMaxToolRounds(value.maxToolRounds),
    disabledTools: Array.isArray(value.disabledTools)
      ? value.disabledTools.filter((n): n is string => typeof n === 'string')
      : [],
    systemPromptOverride: typeof value.systemPromptOverride === 'string' ? value.systemPromptOverride : '',
    saveWorkflowFromChat:
      typeof value.saveWorkflowFromChat === 'boolean' ? value.saveWorkflowFromChat : false,
    downloadAutoSave:
      typeof value.downloadAutoSave === 'boolean' ? value.downloadAutoSave : true,
    imageModel,
    ocrLanguage: typeof value.ocrLanguage === 'string' ? value.ocrLanguage : DEFAULT_SETTINGS.ocrLanguage,
    localAgentEnabled:
      typeof value.localAgentEnabled === 'boolean' ? value.localAgentEnabled : false,
    localAgentToken:
      typeof value.localAgentToken === 'string' ? value.localAgentToken : '',
    localAgentUrl: normalizeLocalAgentUrl(value.localAgentUrl),
    localAgentActiveAgent:
      typeof value.localAgentActiveAgent === 'string' ? value.localAgentActiveAgent : '',
  }
}

/**
 * Stamps the schema version and normalizes stored settings when needed.
 *
 * Runs on install and update, so a corrupted or partial record is repaired once
 * rather than being re-checked on every read path.
 */
export async function ensureSchema(): Promise<void> {
  const stored = await area.get([
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
  await area.set(patch)

  // Ship the built-in skills (e.g. the skill-generator) on install/upgrade.
  await seedBuiltInSkills()
}

/**
 * Inserts any built-in skill that does not already exist (matched by name), so
 * a fresh install or upgrade gets the bundled skills without ever overwriting a
 * skill the user has created or edited.
 */
export async function seedBuiltInSkills(): Promise<void> {
  const skills = await listSkills()
  const known = new Set(skills.map((skill) => skill.name.trim().toLowerCase()))
  for (const builtin of BUILT_IN_SKILLS) {
    if (!known.has(builtin.name.trim().toLowerCase())) {
      await saveSkill(builtin)
    }
  }
}

/** Reads settings, normalizing whatever is on disk. */
export async function getSettings(): Promise<Settings> {
  const stored = await area.get(KEY_SETTINGS)
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
  await area.set({ [KEY_SETTINGS]: merged })
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
 * Conversation history lives in durable storage (files when a directory is
 * configured, else `chrome.storage.local`), not session storage.
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
 * Skills are stored as real files in the general-skill layout — one folder per
 * skill (`skills/<slug>/SKILL.md`, YAML frontmatter + Markdown body) — so they
 * look and behave like the skills a user keeps on disk, and hand-edited files
 * are picked up on the next read. The `skills` key in `chrome.storage.local`
 * remains the fast mirror/fallback: every write updates both, reads prefer the
 * files when the handle is granted and fall back to the mirror otherwise.
 */
export async function listSkills(): Promise<Skill[]> {
  const handle = await getGrantedFsDirectory()
  if (handle) {
    const fromFiles = await readSkillsFromFiles(handle)
    if (fromFiles) return fromFiles
  }
  // Fall back to the chrome.storage mirror when no directory is usable.
  const stored = await area.get(KEY_SKILLS)
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

/**
 * Reads every skill folder as a `SKILL.md`; `null` when the `skills` directory
 * does not exist (nothing on disk yet — the caller falls back to the mirror).
 */
async function readSkillsFromFiles(handle: FileSystemDirectoryHandle): Promise<Skill[] | null> {
  const fs = new FsDirectory(handle)
  const slugs = await fs.listSubdirectories(SKILLS_DIR)
  if (slugs === null) return null
  const skills: Skill[] = []
  for (const slug of slugs) {
    const text = await fs.readText(skillPath(slug))
    if (text === null) continue
    const skill = skillFromMarkdown(text)
    if (skill) skills.push(skill)
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
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
  // Mirror first: keeps the UI/worker view consistent and fires onChanged.
  const skills = await listSkills()
  const existing = skills.find((entry) => entry.id === skill.id)
  if (existing) skills[skills.indexOf(existing)] = skill
  else skills.push(skill)
  skills.sort((a, b) => a.name.localeCompare(b.name))
  await area.set({ [KEY_SKILLS]: skills })

  // Durable copy as a folder-per-skill SKILL.md, like the general skills.
  const handle = await getGrantedFsDirectory()
  if (!handle) return
  const fs = new FsDirectory(handle)
  const slug = skillSlug(skill.name)
  await fs.writeText(skillPath(slug), skillToMarkdown(skill))
  // A rename changes the folder name; drop the stale folder so the old name
  // does not resurface as a duplicate on the next file read.
  if (existing && skillSlug(existing.name) !== slug) {
    await fs.removeDirectory([SKILLS_DIR, skillSlug(existing.name)])
  }
}

export async function deleteSkill(id: string): Promise<void> {
  const skills = await listSkills()
  const victim = skills.find((skill) => skill.id === id)
  await area.set({
    [KEY_SKILLS]: skills.filter((skill) => skill.id !== id),
  })

  const handle = await getGrantedFsDirectory()
  if (handle && victim) {
    const fs = new FsDirectory(handle)
    await fs.removeDirectory([SKILLS_DIR, skillSlug(victim.name)])
  }
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
  const stored = await area.get(key)
  const value = stored[key]
  return Array.isArray(value) ? (value as WireMessage[]) : []
}

/** Persists a conversation, trimmed via {@link trimConversation}. */
export async function saveConversation(
  conversationId: string,
  messages: WireMessage[],
): Promise<void> {
  await area.set({
    [conversationKey(conversationId)]: trimConversation(messages),
  })
}

export async function clearConversation(conversationId: string): Promise<void> {
  await area.remove(conversationKey(conversationId))
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
  const stored = await area.get(KEY_CONVERSATIONS_META)
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
    await area.set({ [KEY_CONVERSATIONS_META]: list })
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
  await area.set({ [KEY_CONVERSATIONS_META]: list })
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
    await area.set({ [KEY_CONVERSATIONS_META]: list })
  }
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const [metaList] = await Promise.all([
    area.get(KEY_CONVERSATIONS_META),
    clearConversation(conversationId),
  ])
  const list = Array.isArray(metaList[KEY_CONVERSATIONS_META])
    ? (metaList[KEY_CONVERSATIONS_META] as ConversationMeta[])
    : []
  await area.set({
    [KEY_CONVERSATIONS_META]: list.filter((meta) => meta.id !== conversationId),
  })
  // Also drop turn state and any history for this thread.
  await chrome.storage.session.remove(`${TURN_STATE_PREFIX}${conversationId}`)
  const all = await listHistory()
  await area.set({
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
  const stored = await area.get(KEY_PROFILES)
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
  await area.set({ [KEY_PROFILES]: list })
}

export async function deleteProfile(id: string): Promise<void> {
  const list = await listProfiles()
  await area.set({
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
  const stored = await area.get(KEY_PASSWORDS)
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
  await area.set({ [KEY_PASSWORDS]: list })
}

export async function deletePassword(id: string): Promise<void> {
  const list = await listPasswords()
  await area.set({
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
    await area.set({ [KEY_PASSWORDS]: list })
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
    ...(entry.args && typeof entry.args === 'object' ? { args: entry.args } : {}),
  }
}

export async function listHistory(): Promise<HistoryEntry[]> {
  const stored = await area.get(KEY_HISTORY)
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
  await area.set({ [KEY_HISTORY]: trimmed })
}

export async function deleteHistory(id: string): Promise<void> {
  const list = await listHistory()
  await area.set({
    [KEY_HISTORY]: list.filter((entry) => entry.id !== id),
  })
}

export async function clearHistory(): Promise<void> {
  await area.set({ [KEY_HISTORY]: [] })
}

// --- Rebuild workflows from action history ----------------------------------

const DEFAULT_WF_SETTINGS: WorkflowSettings = {
  saveLog: false,
  debugMode: false,
  notification: false,
  reuseLastState: false,
}

/** Agent tool action → workflow block id. Actions without a block are skipped.
 *  Ids (and the flat block data from {@link blockDataFromArgs}) follow the
 *  editor's Automa-aligned block catalog, so generated workflows render on the
 *  canvas and run in the engine in the canonical shape (flat `selector` +
 *  `findBy` fields) without relying on migration. */
const ACTION_TO_BLOCK: Record<string, string> = {
  open_url: 'new-tab',
  tab_new: 'new-tab',
  tab_switch: 'switch-tab',
  tab_close: 'close-tab',
  click: 'event-click',
  fill: 'forms',
  select_option: 'forms',
  set_checkbox: 'forms',
  press_key: 'press-key',
  scroll: 'element-scroll',
  // The agent's wait-for-selector paces the replay; the delay block is the
  // catalog's wait primitive (the legacy `wait-for` id has no catalog block).
  wait_for: 'delay',
  // JS the agent ran in the page maps to the catalog's javascript-code block
  // so the workflow replays it — EXCEPT fill-shaped code (a single selector +
  // one literal value write), which becomes the forms operator instead (see
  // {@link fillLikeJsFromCode}): typing into fields is what the forms block is
  // for, and the canvas stays declarative.
  run_javascript: 'javascript-code',
  // The agent's image-text recognition (captchas, image-embedded text) replays
  // as the local `ocr` block: at run time it re-captures the image from the
  // page and reads it offline with Tesseract.js.
  recognize_image: 'ocr',
}

/** The wait-page-load block inserted after navigation steps. */
const WAIT_BLOCK_ID = 'wait-connections'
/** The AI block inserted before form fills whose content should be regenerated. */
const AI_BLOCK_ID = 'ai-agent'
/**
 * Output variable of every generated `ocr` node. A fill that immediately
 * follows a recognition step references it (`{{lastOcrText}}`), so the replay
 * fills the FRESHLY recognized text instead of the conversation's now-stale
 * literal — captchas regenerate on every page load.
 */
const OCR_VARIABLE = 'lastOcrText'
/**
 * Variable an http(s) recognition image is stored in before the `ocr` node
 * reads it (source `'variable'`) — see {@link httpImageUrlArg}.
 */
const OCR_IMAGE_VARIABLE = 'lastOcrImage'

/** One target spec from an agent tool call (the `TARGET_SCHEMA` in agent.ts). */
interface TargetSpec {
  how?: string
  value?: unknown
  tag?: string
  nth?: number
}

/** Best-effort CSS selector from a single target spec ('' when not expressible). */
function selectorFromSpec(spec: TargetSpec | undefined): string {
  if (!spec || typeof spec !== 'object') return ''
  const nth = typeof spec.nth === 'number' && spec.nth > 0 ? `:nth-of-type(${spec.nth + 1})` : ''
  const value = spec.value
  switch (spec.how) {
    case 'css':
      return typeof value === 'string' ? value.trim() : ''
    case 'id':
      return typeof value === 'string' && value.trim() ? `#${value.trim()}` : ''
    case 'name':
      return typeof value === 'string' && value.trim() ? `[name="${value.trim()}"]${nth}` : ''
    case 'testid':
      return typeof value === 'string' && value.trim()
        ? `[data-testid="${value.trim()}"]${nth}`
        : ''
    case 'tag':
      return typeof spec.tag === 'string' && spec.tag.trim() ? `${spec.tag.trim()}${nth}` : ''
    default:
      // role / text — cannot be expressed as a stable CSS selector.
      return ''
  }
}

/**
 * Best-effort CSS selector from an agent action's args. An explicit
 * `selector` wins when present. Otherwise the rich `TargetSpec`'s `primary`
 * is re-expressed into a CSS selector, and when it does not map (the agent
 * usually targets elements by role/text) the `fallbacks` are tried in order —
 * the replayable workflow needs that fallback to carry a usable selector.
 * Mappable specs:
 *   - `how: 'css'`    → the raw selector
 *   - `how: 'id'`     → `#<value>`
 *   - `how: 'name'`   → `[name="<value>"]`
 *   - `how: 'testid'` → `[data-testid="<value>"]`
 *   - `how: 'tag'`    → the tag name (optionally scoped by `nth`)
 * `role`/`text` targets can't be safely turned into a plain CSS selector
 * without knowing the page, so they yield `''` (the node keeps the human
 * description instead).
 */
function selectorFromArgs(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== 'object') return ''
  if (typeof args.selector === 'string' && args.selector.trim()) return args.selector.trim()
  const target = args.target as { primary?: TargetSpec; fallbacks?: TargetSpec[] } | undefined
  if (!target) return ''
  const primary = selectorFromSpec(target.primary)
  if (primary) return primary
  const fallbacks = Array.isArray(target.fallbacks) ? target.fallbacks : []
  for (const spec of fallbacks) {
    const selector = selectorFromSpec(spec)
    if (selector) return selector
  }
  return ''
}

/**
 * Whether two consecutive history steps describe the same replayable action.
 * Navigation with the same URL is always a duplicate; element actions are
 * compared on the signature that actually matters for replay (selector + value).
 */
function sameStep(
  a: Pick<HistoryStep, 'action' | 'args'>,
  b: Pick<HistoryStep, 'action' | 'args'>,
): boolean {
  if (a.action !== b.action) return false
  switch (a.action) {
    case 'open_url':
    case 'tab_new':
      return String(a.args?.url ?? '') === String(b.args?.url ?? '')
    case 'tab_switch':
      return Number(a.args?.index ?? 0) === Number(b.args?.index ?? 0)
    case 'tab_close':
      return true
    case 'press_key':
      return String(a.args?.key ?? '') === String(b.args?.key ?? '')
    case 'click':
    case 'hover':
      return selectorFromArgs(a.args) !== '' && selectorFromArgs(a.args) === selectorFromArgs(b.args)
    case 'fill':
    case 'select_option':
      return (
        selectorFromArgs(a.args) === selectorFromArgs(b.args) &&
        String(a.args?.value ?? '') === String(b.args?.value ?? '')
      )
    case 'set_checkbox':
      return (
        selectorFromArgs(a.args) === selectorFromArgs(b.args) &&
        a.args?.value === b.args?.value
      )
    case 'scroll':
      return (
        String(a.args?.mode ?? 'into_view') === String(b.args?.mode ?? 'into_view') &&
        Number(a.args?.x ?? 0) === Number(b.args?.x ?? 0) &&
        Number(a.args?.y ?? 0) === Number(b.args?.y ?? 0) &&
        selectorFromArgs(a.args) === selectorFromArgs(b.args)
      )
    default:
      return false
  }
}

/** A mapped, replayable history step (host kept for page-change detection). */
interface HistoryStep {
  action: string
  args?: Record<string, unknown>
  host?: string
  summary?: string
}

/**
 * Whether `step` should replace `prev` instead of being appended. Beyond the
 * exact-duplicate rule ({@link sameStep}), consecutive writes to the SAME form
 * field collapse too: at replay the last value wins, so the generated workflow
 * keeps the final fill instead of a chain of corrections.
 */
function collapsesWith(prev: HistoryStep, step: HistoryStep): boolean {
  if (sameStep(prev, step)) return true
  if (prev.action !== step.action) return false
  if (prev.action !== 'fill' && prev.action !== 'select_option' && prev.action !== 'set_checkbox') {
    return false
  }
  const prevSelector = selectorFromArgs(prev.args)
  return prevSelector !== '' && prevSelector === selectorFromArgs(step.args)
}

/**
 * The conversation's rich element locator (`args.target`, the `TARGET_SCHEMA`
 * in agent.ts), passed through verbatim when it is a usable object. The
 * kernel resolves every spec strategy — role/text included — so replay hits
 * the same element even when no CSS selector can express it, and the edit
 * panel has something concrete to show.
 */
function richTargetFromArgs(args: Record<string, unknown> | undefined): unknown {
  const target = args?.target
  if (!target || typeof target !== 'object') return undefined
  const primary = (target as { primary?: unknown }).primary
  if (!primary || typeof primary !== 'object') return undefined
  const spec = primary as { how?: unknown; value?: unknown }
  if (typeof spec.how !== 'string' || !spec.how) return undefined
  if (typeof spec.value !== 'string') return undefined
  return target
}

/** Attach the rich locator to flat block data when present. */
function withRichTarget(
  data: Record<string, unknown>,
  target: unknown,
): Record<string, unknown> {
  return target ? { ...data, target } : data
}

/**
 * Whether a `screenshot` call's prompt asks for text extraction (a captcha
 * code, image-embedded characters, digits). A screenshot has no replayable
 * block by default — it is a visual inspection — but a text-extraction read is
 * exactly what the `ocr` operator replays, so the generator maps those calls
 * onto it. Best-effort by design: "is the button disabled?" stays unmapped
 * while "read the code in the image" becomes an OCR node.
 */
const TEXT_EXTRACTION_PROMPT_RE =
  /captcha|characters?|digits?|\bcode\b|\btext\b|识别|验证码|校验码|文字|字符|数字/i

export function looksTextExtractionPrompt(prompt: string): boolean {
  return TEXT_EXTRACTION_PROMPT_RE.test(prompt)
}

/**
 * Fill-shaped JS detection: recognizes a `run_javascript` snippet that types a
 * literal into exactly one field and returns the data of the equivalent
 * `forms` node, so the generated workflow uses the form operator instead of a
 * JavaScript block. Recognition is deliberately conservative — every condition
 * must hold, and anything ambiguous stays a javascript-code block (faithful
 * replay beats a pretty canvas):
 *   - exactly ONE distinct selector source (`querySelector`/`querySelectorAll`
 *     /`getElementById` literal);
 *   - exactly ONE literal value write — a plain `.value = 'x'` assignment or
 *     the React native-setter pattern (`setter.call(el, 'x')`);
 *   - no other side effects: `.click(` / `.submit(` refuse the conversion
 *     (replaying such a snippet as a forms node would silently drop them).
 * Returns null when the code is not a single-field literal fill — multi-field
 * batches, variable values (e.g. an OCR result held in a JS variable), clicks,
 * or plain reads.
 */
export function fillLikeJsFromCode(code: string): { selector: string; value: string } | null {
  if (!code) return null
  // A click/submit makes the snippet more than a fill — keep it as JS so the
  // replay performs everything the conversation did.
  if (/\.click\s*\(|\.submit\s*\(/.test(code)) return null

  // Collect every selector literal; a fill touches exactly one field.
  const selectors = new Set<string>()
  const selectorRe =
    /querySelector(?:All)?\s*\(\s*(['"])([^'"\n]+)\1|getElementById\s*\(\s*(['"])([^'"\n]+)\3/g
  for (const match of code.matchAll(selectorRe)) {
    if (match[3] !== undefined) selectors.add(`#${match[4]}`)
    else selectors.add((match[2] ?? '').trim())
  }
  if (selectors.size !== 1) return null

  // A value write must be present: a plain assignment or the React native
  // setter descriptor (`…getOwnPropertyDescriptor(HTMLInputElement.prototype,
  // 'value').set` + `setter.call(el, 'x')`).
  const writesValue =
    /\.\s*value\s*=/.test(code) ||
    /getOwnPropertyDescriptor\s*\([^)]*['"]value['"]\s*\)/.test(code)
  if (!writesValue) return null

  // Exactly one literal value. Template-literal `${…}` interpolations and
  // bare identifiers are variables, not literals — excluded.
  const valueRe =
    /\.\s*value\s*=\s*(['"`])([^'"`\\]*)\1(?!\s*\+)|\.call\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*(['"`])([^'"`\\]*)\3(?!\s*\+)/g
  const values: string[] = []
  for (const match of code.matchAll(valueRe)) {
    const value = match[2] ?? match[4] ?? ''
    if (value && !value.includes('${')) values.push(value)
  }
  if (values.length !== 1) return null
  return { selector: [...selectors][0]!, value: values[0]! }
}

/** The literal a fill/select/JS-fill step would write (null when there is none). */
function literalFillValue(step: HistoryStep): string | null {
  if (step.action === 'run_javascript') {
    const code = typeof step.args?.code === 'string' ? step.args.code : ''
    return fillLikeJsFromCode(code)?.value ?? null
  }
  if (step.action !== 'fill' && step.action !== 'select_option') return null
  const value = step.args?.value
  return typeof value === 'string' ? value : null
}

/**
 * Captcha-token shape: short and single-line — small enough that re-reading
 * the image at replay is what the user wants, unlike long composed prose
 * (which goes through the AI prefill path instead).
 */
function isShortToken(value: string): boolean {
  return value.length > 0 && value.length <= 32 && !value.includes('\n')
}

/**
 * The catalog block a recorded action maps to. Usually the static
 * {@link ACTION_TO_BLOCK} entry; fill-shaped `run_javascript` code resolves to
 * `forms` instead of `javascript-code` — the SAME condition
 * {@link blockDataFromArgs} uses, so the node id and its data always agree.
 */
function blockIdForStep(action: string, args?: Record<string, unknown>): string {
  if (action === 'run_javascript') {
    const code = typeof args?.code === 'string' ? args.code : ''
    if (fillLikeJsFromCode(code)) return 'forms'
  }
  return ACTION_TO_BLOCK[action]!
}

/** Selector synthesized from fill-shaped JS (empty when the step is not one). */
function jsFillSelector(step: HistoryStep): string {
  if (step.action !== 'run_javascript') return ''
  const code = typeof step.args?.code === 'string' ? step.args.code : ''
  return fillLikeJsFromCode(code)?.selector ?? ''
}

/**
 * Index of the recognition step a fill/select/JS-fill step transcribes, or -1.
 * Walks back a few steps so pacing actions between the recognition and the
 * fill (wait_for, a captcha-refresh click, a scroll) do not break the
 * hand-off; stops at ANOTHER form write, which claims the recognition first.
 */
function recognitionBefore(steps: HistoryStep[], i: number): number {
  const action = steps[i]!.action
  if (action !== 'fill' && action !== 'select_option' && action !== 'run_javascript') return -1
  for (let j = i - 1; j >= 0 && j >= i - 4; j -= 1) {
    const step = steps[j]!
    if (step.action === 'recognize_image') return j
    // Another form write claims the hand-off before this step does; a
    // fill-shaped JS snippet is a form write too.
    if (step.action === 'fill' || step.action === 'select_option') return -1
    if (step.action === 'run_javascript' && fillLikeJsFromCode(String(step.args?.code ?? ''))) {
      return -1
    }
  }
  return -1
}

/**
 * The http(s) `image` argument of a recognition call, when present. Data URLs
 * and bare base64 are transient conversation bytes — never persisted; an
 * http(s) URL, by contrast, is what the conversation actually READ from, and
 * is replayable (the ocr block's variable source fetches it fresh).
 */
function httpImageUrlArg(args: Record<string, unknown> | undefined): string {
  const image = typeof args?.image === 'string' ? args.image.trim() : ''
  return /^https?:\/\//i.test(image) ? image : ''
}

/**
 * Builds the canonical flat block data for a mapped tool action, best-effort
 * from its args. `aiVar` (set for AI-prefilled fills) replaces the literal
 * value with a `{{variable}}` reference to the preceding `ai-agent` node;
 * `ocrVar` (set for fills that immediately follow a recognition step) does the
 * same against the preceding `ocr` node, so the replay reads the FRESH text.
 */
function blockDataFromArgs(
  action: string,
  args: Record<string, unknown> | undefined,
  aiVar?: string,
  ocrVar?: string,
): Record<string, unknown> {
  const selector = selectorFromArgs(args)
  const target = richTargetFromArgs(args)
  switch (action) {
    case 'open_url':
    case 'tab_new':
      // The executor waits for the tab to finish loading unless opted out.
      return { url: typeof args?.url === 'string' ? args.url : '', waitTabLoaded: true }
    case 'tab_switch':
      return { index: Number(args?.index ?? 0) }
    case 'tab_close':
      return {}
    case 'click':
      return withRichTarget({ selector, findBy: 'cssSelector' }, target)
    case 'fill':
      return withRichTarget(
        {
          selector,
          findBy: 'cssSelector',
          type: 'text-field',
          value: aiVar
            ? `{{${aiVar}}}`
            : ocrVar
              ? `{{${ocrVar}}}`
              : typeof args?.value === 'string'
                ? args.value
                : '',
          clearValue: true,
        },
        target,
      )
    case 'select_option':
      return withRichTarget(
        {
          selector,
          findBy: 'cssSelector',
          type: 'select',
          value: aiVar
            ? `{{${aiVar}}}`
            : ocrVar
              ? `{{${ocrVar}}}`
              : typeof args?.value === 'string'
                ? args.value
                : '',
        },
        target,
      )
    case 'set_checkbox': {
      const checked = args?.value !== false
      // `value` drives the executor; `selected` drives the edit form.
      return withRichTarget(
        { selector, findBy: 'cssSelector', type: 'checkbox', value: checked, selected: checked },
        target,
      )
    }
    case 'press_key':
      return { key: typeof args?.key === 'string' ? args.key : '' }
    case 'scroll': {
      const mode = typeof args?.mode === 'string' ? args.mode : 'into_view'
      // into_view keeps its element target even when the locator is role/text
      // (no CSS selector) — the rich target below carries it.
      if (mode === 'into_view' && (selector || target)) {
        return withRichTarget({ selector, findBy: 'cssSelector', scrollIntoView: true }, target)
      }
      // `element-scroll` models top/bottom/by as an X/Y wheel scroll.
      const y =
        mode === 'top' ? 0 : mode === 'bottom' ? 100000 : typeof args?.y === 'number' ? args.y : 600
      return { scrollX: typeof args?.x === 'number' ? args.x : 0, scrollY: y }
    }
    case 'wait_for':
      // Mapped to the `delay` block: replay the agent's pacing as a pause.
      // `time` is the catalog + edit-form key (what the executor reads).
      return { time: Number(args?.timeout ?? 5000) }
    case 'run_javascript': {
      const code = typeof args?.code === 'string' ? args.code : ''
      // Fill-shaped JS (one selector, one literal value write) becomes the
      // forms operator: typing into fields is what the forms block is for, and
      // a following OCR node can hand off {{lastOcrText}} exactly like a real
      // fill. Anything ambiguous replays verbatim through the same harness the
      // agent used. Timeout mirrors the catalog default so the edit panel
      // shows a real value.
      const fill = fillLikeJsFromCode(code)
      if (fill) {
        return {
          selector: fill.selector,
          findBy: 'cssSelector',
          type: 'text-field',
          value: ocrVar ? `{{${ocrVar}}}` : fill.value,
          clearValue: true,
        }
      }
      return { code, timeout: 20000 }
    }
    case 'recognize_image':
      // Replays as a live OCR capture. An http(s) `image` argument is what the
      // conversation actually READ from (usually the <img> src) — it replays
      // through the variable source (the generator stores the URL in
      // `lastOcrImage` first); fetching it fresh is more faithful than an
      // element capture, which page CSP or late rendering can break. With
      // only a selector the block re-captures that img element at run time;
      // with neither it reads the visible page. The captcha preprocess
      // (upscale + contrast) is tuned for SMALL images: an element/variable
      // capture keeps it, a full-page shot skips it — binarizing a whole page
      // washes the text out and the read comes back empty. A data-URL `image`
      // arg is transient (its bytes exist only inside the conversation) and
      // is intentionally not persisted into the workflow. The recognized
      // string (type always string) lands in the block's output variable,
      // default `lastOcrText`.
      if (httpImageUrlArg(args)) {
        return {
          source: 'variable',
          imageVariable: OCR_IMAGE_VARIABLE,
          preprocess: true,
          variableName: OCR_VARIABLE,
        }
      }
      return withRichTarget(
        {
          source: selector ? 'element' : 'page',
          selector,
          findBy: 'cssSelector',
          preprocess: Boolean(selector),
          variableName: OCR_VARIABLE,
        },
        selector ? target : undefined,
      )
    default:
      return {}
  }
}

/** Cap the reference value shipped inside the AI block's prompt. */
const AI_REFERENCE_CAP = 200

/**
 * Whether a fill value looks like content the model composed (long free text /
 * multi-line), as opposed to literal data a user would dictate. Explicit data
 * shapes (email / URL / number / date) never count as composed prose.
 */
function looksAiComposed(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  if (!v.includes('\n') && v.length < 24) return false
  if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(v)) return false
  if (/^https?:\/\//i.test(v)) return false
  if (/^-?\d+([.,]\d+)?$/.test(v)) return false
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(v)) return false
  return true
}

/**
 * Whether a fill step's content should be regenerated by an `ai-agent` block
 * at replay time instead of replaying the literal value. The agent self-
 * reports with `args.generated` (set when it composed the text itself);
 * history entries without the flag fall back to a conservative length /
 * multi-line heuristic.
 */
function wantsAiPrefill(step: HistoryStep): boolean {
  if (step.action !== 'fill') return false
  const generated = step.args?.generated
  if (generated === true) return true
  if (generated === false) return false
  const value = typeof step.args?.value === 'string' ? step.args.value : ''
  return looksAiComposed(value)
}

/** Human name of the form field a fill step targeted (for the AI prompt). */
function fieldLabel(step: HistoryStep): string {
  const target = step.args?.target as { label?: unknown } | undefined
  return (
    (typeof step.args?.label === 'string' && step.args.label.trim()) ||
    (typeof target?.label === 'string' && target.label.trim() ? target.label.trim() : '') ||
    (step.summary ?? '') ||
    selectorFromArgs(step.args) ||
    '表单字段'
  )
}

/**
 * Human context for the generated node. The agent's short `label` wins; a
 * step without a usable selector keeps the full summary so the canvas card
 * still says what the step does (when a selector is present, the card shows
 * the selector instead).
 */
function nodeDescription(step: HistoryStep, selector: string): string {
  const target = step.args?.target as { label?: unknown } | undefined
  const label =
    (typeof step.args?.label === 'string' && step.args.label.trim()) ||
    (typeof target?.label === 'string' && target.label.trim() ? target.label.trim() : '')
  if (label) return label
  return selector === '' && step.summary ? step.summary : ''
}

/**
 * Turns an ordered list of action-history entries (oldest first) into a linear
 * workflow of mapped browser/navigation steps in the editor's canonical shape
 * (Automa block ids + flat `selector`/`findBy` data) — no migration needed for
 * the editor or the engine to render/run it. Entries with no mapped block are
 * skipped.
 *
 * Consecutive steps that describe the same replayable action — or repeated
 * writes to the same form field — collapse to one node keeping the FINAL
 * occurrence, the one that reflects the state the conversation ended in.
 *
 * A wait-page-load (`wait-connections`) node follows every navigation step,
 * and follows a click/keypress whose next step lands on a different host, so
 * the replay never outruns the page it drives.
 *
 * Fill steps whose content the model composed get an `ai-agent` node that
 * regenerates the content at replay time (see {@link wantsAiPrefill}).
 *
 * Fill-shaped `run_javascript` snippets (one selector, one literal value
 * write — see {@link fillLikeJsFromCode}) become `forms` nodes instead of
 * javascript-code, so form filling always shows up as the form operator. A
 * fill that immediately follows a recognition step references `{{lastOcrText}}`
 * (see {@link OCR_VARIABLE}) and a text-extraction `screenshot` is replayed as
 * an `ocr` node, so image recognition always shows up as the OCR operator.
 * Returns `null` when nothing could be mapped.
 */
export function workflowFromHistory(entries: HistoryEntry[], name: string): Workflow | null {
  const steps: HistoryStep[] = []
  for (const entry of entries) {
    // A `screenshot` whose prompt asks for text extraction (reading a captcha,
    // image-embedded characters) replays as the `ocr` operator just like
    // recognize_image; plain visual-inspection screenshots have no replayable
    // block and are skipped. The selector arg name differs (`target` here).
    let action = entry.action
    let args: Record<string, unknown> | undefined = entry.args
    if (action === 'screenshot') {
      const prompt = typeof args?.prompt === 'string' ? args.prompt : ''
      if (!looksTextExtractionPrompt(prompt)) continue
      action = 'recognize_image'
      args = { selector: typeof args?.target === 'string' ? args.target : '', prompt }
    }
    if (!ACTION_TO_BLOCK[action]) continue
    const step: HistoryStep = {
      action,
      ...(args && typeof args === 'object' ? { args } : {}),
      ...(entry.host ? { host: entry.host } : {}),
      ...(entry.summary ? { summary: entry.summary } : {}),
    }
    const prev = steps[steps.length - 1]
    if (prev && collapsesWith(prev, step)) steps[steps.length - 1] = step
    else steps.push(step)
  }
  if (steps.length === 0) return null

  const nodes: WorkflowNode[] = []
  const edges: WorkflowEdge[] = []

  // Trigger node — the first node in the graph, matching automa's convention.
  // `label` holds the block id (same as data.blockId); the editor resolves the
  // localized display name from the block registry at render time.
  const triggerId = newId()
  nodes.push({
    id: triggerId,
    label: 'trigger',
    position: { x: 160, y: 0 },
    data: { blockId: 'trigger', type: 'manual', description: '' },
  })
  let prevId: string = triggerId
  let prevBlockId = 'trigger'
  let aiSeq = 0
  let ocrExtractSeq = 0
  /** Recognition step index → the ai-agent extraction variable added for it. */
  const extractVarByRecognition = new Map<number, string>()
  let y = 80

  /**
   * Appends a node and its incoming edge. Edges carry BLOCK-KEYED handles
   * (`<blockId>-output-1` → `<blockId>-input-1`) — the same shape the
   * recorder emits and the canvas renders, so generated connections draw
   * instead of relying on React Flow's null-handle fallback.
   */
  const addNode = (blockId: string, data: Record<string, unknown>): string => {
    const id = newId()
    nodes.push({ id, label: blockId, position: { x: 160, y }, data: { blockId, ...data } })
    edges.push({
      id: newId(),
      source: prevId,
      target: id,
      sourceHandle: `${prevBlockId}-output-1`,
      targetHandle: `${blockId}-input-1`,
    })
    prevId = id
    prevBlockId = blockId
    return id
  }

  steps.forEach((step, i) => {
    y = 80 + i * 140
    // A fill-shaped JS step carries its selector inside the code — once it
    // becomes a forms node the card shows the selector, so the description
    // logic must see it (nodeDescription keeps the summary only when there is
    // no selector to show).
    const selector = selectorFromArgs(step.args) || jsFillSelector(step)
    const description = nodeDescription(step, selector)

    // OCR hand-off FIRST: a short-token fill shortly after a recognition step
    // is a TRANSCRIPTION (the captcha code just read), not composed content —
    // the AI-prefill path below must not claim it. The linked forms node reads
    // the FRESH recognition output at replay — either `{{lastOcrText}}` or,
    // when the recognition was a whole-page OCR, the extraction node's
    // `{{ocrExtractN}}` (the raw dump must not reach the form). Long composed
    // content keeps the AI-prefill path.
    const recognizedAt = recognitionBefore(steps, i)
    let ocrVar: string | undefined
    if (recognizedAt >= 0 && isShortToken(literalFillValue(step) ?? '')) {
      ocrVar = extractVarByRecognition.get(recognizedAt) ?? OCR_VARIABLE
    }

    // AI prefill: an `ai-agent` node regenerates the content at replay time;
    // the following forms node references it through `{{variableName}}`.
    let aiVar: string | undefined
    if (!ocrVar && wantsAiPrefill(step)) {
      aiSeq += 1
      aiVar = `aiFill${aiSeq}`
      const rawValue = typeof step.args?.value === 'string' ? step.args.value : ''
      const reference =
        rawValue.length > AI_REFERENCE_CAP ? `${rawValue.slice(0, AI_REFERENCE_CAP)}…` : rawValue
      addNode(AI_BLOCK_ID, {
        description: `AI 生成表单内容: ${fieldLabel(step)}`,
        prompt:
          `为网页表单字段「${fieldLabel(step)}」生成要填写的内容。` +
          '直接输出可填入输入框的纯文本，不要解释、不要引号。' +
          `参考（对话中填写的同用途内容）：${reference}`,
        findBy: 'cssSelector',
        selector: '',
        actOnPage: false,
        useSnapshot: false,
        maxToolRounds: 8,
        variableName: aiVar,
        // Kept so the save-card toggle can restore the literal value.
        referenceValue: rawValue,
      })
    }

    // A recognition that succeeded through an http(s) `image` argument (the
    // model's preferred shape — the <img> src it already had) replays through
    // the variable source: the URL is stored in a variable first, then the ocr
    // node reads it. An element capture can be blocked by the page's CSP or
    // run before a late-rendered captcha exists; fetching the URL is what
    // actually succeeded in the conversation.
    if (step.action === 'recognize_image') {
      const imageUrl = httpImageUrlArg(step.args)
      if (imageUrl) {
        addNode('set-variable', {
          description: '记录识别图片地址',
          variableName: OCR_IMAGE_VARIABLE,
          value: imageUrl,
        })
      }
    }

    const blockId = blockIdForStep(step.action, step.args)
    addNode(blockId, {
      description,
      ...blockDataFromArgs(step.action, step.args, aiVar, ocrVar),
    })

    // A recognition with NEITHER an image nor a selector OCR'd the WHOLE
    // visible page — in the conversation the model then picked the wanted
    // value out of the noisy dump, and the replay needs the same brain: an
    // ai-agent extraction node (after the ocr node it reads) turns
    // `lastOcrText` (the full-page dump) into the answer the flow actually
    // fills (see extractVarByRecognition).
    if (step.action === 'recognize_image' && !httpImageUrlArg(step.args) && !selector) {
      ocrExtractSeq += 1
      const extractVar = `ocrExtract${ocrExtractSeq}`
      const ask =
        typeof step.args?.prompt === 'string' && step.args.prompt.trim()
          ? step.args.prompt.trim()
          : '提取关键信息'
      addNode(AI_BLOCK_ID, {
        description: '提取 OCR 中的关键信息',
        // Not a save-card prefill row: the extraction is functionally
        // required — without it the fill would receive the raw page dump.
        purpose: 'ocr-extract',
        prompt:
          `${ask}\n\n` +
          '以上是要求。下面是页面 OCR 识别出的全部文本（可能包含大量无关噪声），' +
          '根据要求从文本中得出答案，只输出结果本身，不要解释、不要引号。\n\n' +
          'OCR 文本：\n{{lastOcrText}}',
        findBy: 'cssSelector',
        selector: '',
        actOnPage: false,
        useSnapshot: false,
        maxToolRounds: 8,
        variableName: extractVar,
      })
      extractVarByRecognition.set(i, extractVar)
    }

    // Pace the replay: always wait after navigation; after a click/keypress
    // only when the next step lands on a different host (a page change).
    const next = steps[i + 1]
    const navigated = step.action === 'open_url' || step.action === 'tab_new'
    const hostChanged =
      (step.action === 'click' || step.action === 'press_key') &&
      !!step.host &&
      !!next?.host &&
      step.host !== next.host
    if (navigated || hostChanged) {
      addNode(WAIT_BLOCK_ID, { description: '等待页面加载', timeout: 10000 })
    }
  })

  return {
    id: newId(),
    name: name.trim() || 'From history',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    drawflow: { nodes, edges, position: { x: 0, y: 0 }, zoom: 1 },
    trigger: { type: 'manual', enabled: true },
    settings: { ...DEFAULT_WF_SETTINGS },
  }
}

/** One fill step whose content is wired to an `ai-agent` node. */
export interface AiPrefillStep {
  /** The `forms` node id (the save-card toggle key). */
  nodeId: string
  /** Human label shown on the save card. */
  label: string
  /** The literal value captured in the conversation (fallback when off). */
  referenceValue: string
}

const VAR_TOKEN = /^\{\{\s*([^{}\s]+)\s*\}\}$/

/** Lists the AI-prefilled form steps of a generated workflow (save-card rows). */
export function aiPrefillSteps(workflow: Workflow): AiPrefillStep[] {
  const nodes = workflow.drawflow.nodes
  const steps: AiPrefillStep[] = []
  for (const node of nodes) {
    if (node.data?.blockId !== 'forms') continue
    const variableName = VAR_TOKEN.exec(String(node.data.value ?? ''))?.[1]
    if (!variableName) continue
    const aiNode = nodes.find(
      (n) =>
        n.data?.blockId === AI_BLOCK_ID &&
        n.data?.variableName === variableName &&
        // An OCR-extraction agent is not a prefill choice — it is required
        // for the flow to produce the right value at all.
        n.data?.purpose !== 'ocr-extract',
    )
    if (!aiNode) continue
    steps.push({
      nodeId: node.id,
      label: String(aiNode.data?.description ?? '').replace(/^AI 生成表单内容: /, ''),
      referenceValue: String(aiNode.data?.referenceValue ?? ''),
    })
  }
  return steps
}

/**
 * Applies the user's save-card choices to a generated workflow: an enabled
 * step keeps its `ai-agent` node and the `{{variable}}` reference; a disabled
 * one falls back to the literal conversation value and disables (skips) the
 * AI node, keeping the graph shape intact. Idempotent in both directions.
 */
export function applyAiPrefillOptions(
  workflow: Workflow,
  /** forms node id → whether the content should be AI-generated at replay. */
  selections: Record<string, boolean>,
): Workflow {
  const nodes = workflow.drawflow.nodes
  /** variableName → the ai-agent node wired to it. */
  const aiByVar = new Map<string, WorkflowNode>()
  for (const node of nodes) {
    if (node.data?.blockId !== AI_BLOCK_ID) continue
    // OCR-extraction agents are not save-card controllable (see aiPrefillSteps).
    if (node.data?.purpose === 'ocr-extract') continue
    const variableName = String(node.data.variableName ?? '')
    if (variableName) aiByVar.set(variableName, node)
  }
  const nextNodes = nodes.map((node) => {
    if (node.data?.blockId !== 'forms') return node
    const variableName = VAR_TOKEN.exec(String(node.data.value ?? ''))?.[1]
    if (!variableName || !aiByVar.has(variableName)) return node
    const desired = selections[node.id]
    if (desired === undefined) return node
    if (desired) {
      if (String(node.data.value) === `{{${variableName}}}`) return node
      return { ...node, data: { ...node.data, value: `{{${variableName}}}` } }
    }
    const referenceValue = String(aiByVar.get(variableName)?.data?.referenceValue ?? '')
    return { ...node, data: { ...node.data, value: referenceValue } }
  })
  // Enable/disable each paired ai-agent node alongside its forms step.
  const finalNodes = nextNodes.map((node) => {
    if (node.data?.blockId !== AI_BLOCK_ID) return node
    // OCR-extraction agents are not save-card controllable (see aiPrefillSteps).
    if (node.data?.purpose === 'ocr-extract') return node
    const variableName = String(node.data.variableName ?? '')
    // Pair against the ORIGINAL nodes: the disable direction already replaced
    // the forms `{{var}}` value with the literal above, so the post-update list
    // no longer contains the token and the owner would never be found.
    const owner = nodes.find(
      (other) =>
        other.data?.blockId === 'forms' &&
        VAR_TOKEN.exec(String(other.data.value ?? ''))?.[1] === variableName,
    )
    const desired = owner ? selections[owner.id] : undefined
    if (desired === undefined) return node
    if ((node.data.disableBlock === true) === !desired) return node
    return { ...node, data: { ...node.data, disableBlock: !desired } }
  })
  return { ...workflow, drawflow: { ...workflow.drawflow, nodes: finalNodes } }
}
