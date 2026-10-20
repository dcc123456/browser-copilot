/**
 * Envelope + coercion for the secrets / profiles export file.
 *
 * The file is a single envelope holding both kinds of records, so a file
 * written by either panel section can be read back by the import button in
 * either section. Imported records are always **new** entries: ids and
 * timestamps are regenerated, so an import never overwrites what the machine
 * already holds.
 *
 * @module lib/data-export
 */
import type { PasswordEntry, SecretField, UserProfile } from './types'
import { entryFields } from './types'
import { newId } from './storage'

export const DATA_EXPORT_TYPE = 'browser-copilot-data'

export interface DataExport {
  type: typeof DATA_EXPORT_TYPE
  version: 1
  exportedAt: number
  profiles: UserProfile[]
  secrets: PasswordEntry[]
}

/** Builds the export envelope for the given records. */
export function buildDataExport(input: {
  profiles?: UserProfile[]
  secrets?: PasswordEntry[]
  at?: number
}): DataExport {
  return {
    type: DATA_EXPORT_TYPE,
    version: 1,
    exportedAt: input.at ?? Date.now(),
    profiles: input.profiles ?? [],
    secrets: input.secrets ?? [],
  }
}

/** True when the value is a well-formed export envelope. */
export function isDataExport(value: unknown): value is DataExport {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<DataExport>
  return (
    candidate.type === DATA_EXPORT_TYPE &&
    candidate.version === 1 &&
    Array.isArray(candidate.profiles) &&
    Array.isArray(candidate.secrets)
  )
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readCustom(raw: Record<string, unknown>): Record<string, string> {
  const source = raw['custom']
  if (!source || typeof source !== 'object') return {}
  const custom: Record<string, string> = {}
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value === 'string') custom[key] = value
  }
  return custom
}

/**
 * Normalises an arbitrary JSON value into a profile with a fresh id.
 * Returns `null` when the record has no label — a profile without a label
 * cannot be addressed in the UI.
 */
export function coerceImportedProfile(raw: unknown, now: number): UserProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const label = readString(record['label']).trim()
  if (!label) return null
  return {
    id: newId(),
    label,
    fullName: readString(record['fullName']),
    firstName: readString(record['firstName']),
    lastName: readString(record['lastName']),
    email: readString(record['email']),
    phone: readString(record['phone']),
    address: readString(record['address']),
    city: readString(record['city']),
    state: readString(record['state']),
    postalCode: readString(record['postalCode']),
    country: readString(record['country']),
    company: readString(record['company']),
    jobTitle: readString(record['jobTitle']),
    custom: readCustom(record),
    createdAt: now,
    updatedAt: now,
  }
}

function readFields(raw: Record<string, unknown>): SecretField[] {
  const list = raw['fields']
  if (!Array.isArray(list)) return []
  const fields: SecretField[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const field = item as Record<string, unknown>
    const key = readString(field['key']).trim()
    if (!key) continue
    fields.push({
      key,
      value: readString(field['value']),
      ...(field['secret'] === true ? { secret: true } : {}),
    })
  }
  return fields
}

/**
 * Normalises an arbitrary JSON value into a secret entry with a fresh id.
 * Legacy `username`/`password`/`notes` records are migrated through
 * `entryFields()` so an old export still imports.
 */
export function coerceImportedSecret(raw: unknown, now: number): PasswordEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const label = readString(record['label']).trim()
  if (!label) return null
  const legacy = {
    username: readString(record['username']),
    password: readString(record['password']),
    notes: readString(record['notes']),
  }
  const fields = readFields(record)
  const entry: PasswordEntry = {
    id: newId(),
    label,
    url: readString(record['url']),
    fields,
    createdAt: now,
    updatedAt: now,
    useCount: 0,
  }
  if (fields.length === 0) {
    // `entryFields` folds the deprecated columns into `fields` for us.
    entry.fields = entryFields({ ...entry, ...legacy })
  }
  return entry
}
