/**
 * The secrets / profiles export envelope and its import coercion.
 *
 * The rule that matters: an import always creates NEW records. Ids are
 * regenerated, so importing a file can never overwrite what the machine
 * already stores.
 */
import { describe, expect, it } from 'vitest'
import {
  DATA_EXPORT_TYPE,
  buildDataExport,
  coerceImportedProfile,
  coerceImportedSecret,
  isDataExport,
} from '../src/lib/data-export'

const NOW = 1_700_000_000_000

describe('data export envelope', () => {
  it('carries both kinds of records', () => {
    const envelope = buildDataExport({
      profiles: [
        {
          id: 'p1',
          label: 'Personal',
          custom: {},
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      at: NOW,
    })
    expect(envelope.type).toBe(DATA_EXPORT_TYPE)
    expect(envelope.version).toBe(1)
    expect(envelope.exportedAt).toBe(NOW)
    expect(envelope.profiles).toHaveLength(1)
    expect(envelope.secrets).toEqual([])
    expect(isDataExport(envelope)).toBe(true)
  })

  it('rejects anything that is not an envelope', () => {
    expect(isDataExport(null)).toBe(false)
    expect(isDataExport({})).toBe(false)
    expect(isDataExport({ type: 'other', version: 1, profiles: [], secrets: [] })).toBe(false)
    expect(isDataExport({ type: DATA_EXPORT_TYPE, version: 2, profiles: [], secrets: [] })).toBe(
      false,
    )
    expect(isDataExport({ type: DATA_EXPORT_TYPE, version: 1, profiles: [] })).toBe(false)
  })
})

describe('coerceImportedProfile', () => {
  it('keeps the known fields and the custom field map', () => {
    const profile = coerceImportedProfile(
      {
        id: 'old-id',
        label: 'Work',
        fullName: 'Ada Lovelace',
        email: 'ada@example.com',
        custom: { birthday: '1815-12-10', team: 'eng' },
        createdAt: 1,
        updatedAt: 1,
      },
      NOW,
    )
    expect(profile).not.toBeNull()
    expect(profile?.id).not.toBe('old-id')
    expect(profile?.label).toBe('Work')
    expect(profile?.email).toBe('ada@example.com')
    expect(profile?.custom).toEqual({ birthday: '1815-12-10', team: 'eng' })
    expect(profile?.createdAt).toBe(NOW)
    expect(profile?.updatedAt).toBe(NOW)
  })

  it('rejects a record without a label', () => {
    expect(coerceImportedProfile({ label: '  ' }, NOW)).toBeNull()
    expect(coerceImportedProfile({ fullName: 'no label' }, NOW)).toBeNull()
    expect(coerceImportedProfile('nonsense', NOW)).toBeNull()
  })
})

describe('coerceImportedSecret', () => {
  it('keeps the fields and resets the usage counter', () => {
    const entry = coerceImportedSecret(
      {
        id: 'old-id',
        label: 'GitHub',
        url: 'https://github.com',
        fields: [
          { key: 'username', value: 'ada' },
          { key: 'password', value: 'hunter2', secret: true },
        ],
        useCount: 12,
      },
      NOW,
    )
    expect(entry).not.toBeNull()
    expect(entry?.id).not.toBe('old-id')
    expect(entry?.label).toBe('GitHub')
    expect(entry?.url).toBe('https://github.com')
    expect(entry?.useCount).toBe(0)
    expect(entry?.fields).toEqual([
      { key: 'username', value: 'ada' },
      { key: 'password', value: 'hunter2', secret: true },
    ])
  })

  it('migrates the deprecated username/password columns', () => {
    const entry = coerceImportedSecret(
      { id: 'old', label: 'Legacy', username: 'ada', password: 'hunter2' },
      NOW,
    )
    expect(entry?.fields).toEqual([
      { key: 'username', value: 'ada' },
      { key: 'password', value: 'hunter2', secret: true },
    ])
  })

  it('rejects a record without a label and drops malformed fields', () => {
    expect(coerceImportedSecret({ fields: [] }, NOW)).toBeNull()
    const entry = coerceImportedSecret(
      {
        label: 'Mixed',
        fields: [
          { key: '', value: 'x' },
          { key: 'ok', value: 'y' },
        ],
      },
      NOW,
    )
    expect(entry?.fields).toEqual([{ key: 'ok', value: 'y' }])
  })
})
