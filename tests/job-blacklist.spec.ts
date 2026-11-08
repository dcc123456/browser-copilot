import { describe, expect, it } from 'vitest'
import {
  normalizeBlacklistEntries,
  normalizeJobBlacklist,
  parseJobBlacklistLines,
} from '../src/lib/job-blacklist'
import { DEFAULT_SETTINGS, normalizeStoredSettings } from '../src/lib/storage'

describe('job blacklist entries', () => {
  it('parses one entry per line, trimming and dropping blanks', () => {
    expect(parseJobBlacklistLines(' Acme \n\n外包公司\r\n  ')).toEqual(['Acme', '外包公司'])
  })

  it('dedupes case-insensitively and keeps the first spelling', () => {
    expect(normalizeBlacklistEntries(['Acme', 'acme', 'ACME', 'Beta'])).toEqual(['Acme', 'Beta'])
  })

  it('ignores non-string entries from a hand-edited store', () => {
    expect(normalizeBlacklistEntries(['Acme', 42, null, { name: 'Beta' }, 'Gamma'])).toEqual([
      'Acme',
      'Gamma',
    ])
  })
})

describe('normalizeJobBlacklist', () => {
  it('returns empty lists for a missing value', () => {
    expect(normalizeJobBlacklist(undefined)).toEqual({
      companies: [],
      headhunterPositions: [],
      excludeHeadhunters: false,
    })
  })

  it('keeps valid values and normalizes each list', () => {
    expect(
      normalizeJobBlacklist({
        companies: [' Acme ', 'acme'],
        headhunterPositions: ['某猎头'],
        excludeHeadhunters: true,
      }),
    ).toEqual({
      companies: ['Acme'],
      headhunterPositions: ['某猎头'],
      excludeHeadhunters: true,
    })
  })

  it('treats a non-boolean switch as off', () => {
    expect(normalizeJobBlacklist({ excludeHeadhunters: 'yes' }).excludeHeadhunters).toBe(false)
  })
})

describe('settings storage', () => {
  it('defaults to empty job blacklists', () => {
    expect(DEFAULT_SETTINGS.jobBlacklist).toEqual({
      companies: [],
      headhunterPositions: [],
      excludeHeadhunters: false,
    })
  })

  it('normalizes a stored job blacklist', () => {
    const settings = normalizeStoredSettings({
      jobBlacklist: {
        companies: ['Acme', ' acme ', ''],
        headhunterPositions: ['外包'],
        excludeHeadhunters: true,
      },
    })
    expect(settings.jobBlacklist).toEqual({
      companies: ['Acme'],
      headhunterPositions: ['外包'],
      excludeHeadhunters: true,
    })
  })
})
