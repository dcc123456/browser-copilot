import { describe, expect, it } from 'vitest'
import { matchesAccept, pickLatestFile } from '../src/lib/workflow/latest-file'

function candidate(name: string, lastModified: number, mimeType?: string) {
  return { name, lastModified, ...(mimeType ? { mimeType } : {}) }
}

describe('matchesAccept', () => {
  it('accepts everything when the list is empty', () => {
    expect(matchesAccept('', 'report.xlsx')).toBe(true)
    expect(matchesAccept('   ', 'report.xlsx')).toBe(true)
    expect(matchesAccept('*/*', 'report.xlsx')).toBe(true)
  })

  it('matches extensions case-insensitively, including bare extensions', () => {
    expect(matchesAccept('.xlsx', 'REPORT.XLSX')).toBe(true)
    expect(matchesAccept('.csv,.xlsx', 'data.csv')).toBe(true)
    expect(matchesAccept('xlsx', 'data.xlsx')).toBe(true)
    expect(matchesAccept('.csv', 'data.xlsx')).toBe(false)
  })

  it('matches MIME wildcards and exact MIME types', () => {
    expect(matchesAccept('image/*', 'shot.png')).toBe(true)
    expect(matchesAccept('image/*', 'report.pdf')).toBe(false)
    expect(matchesAccept('text/csv', 'data.csv')).toBe(true)
    expect(
      matchesAccept(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'data.xlsx',
      ),
    ).toBe(true)
  })

  it('accepts a file whose host MIME is generic but whose extension matches', () => {
    expect(matchesAccept('.xlsx', 'data.xlsx', 'application/octet-stream')).toBe(true)
  })
})

describe('pickLatestFile', () => {
  const files = [
    candidate('report-2026-01.xlsx', 1_000),
    candidate('report-2026-03.xlsx', 3_000),
    candidate('report-2026-02.csv', 2_000),
    candidate('notes.txt', 9_000),
  ]

  it('picks the newest candidate', () => {
    expect(pickLatestFile(files)?.name).toBe('notes.txt')
  })

  it('filters by accept before comparing times', () => {
    expect(pickLatestFile(files, { accept: '.xlsx' })?.name).toBe('report-2026-03.xlsx')
  })

  it('filters by glob pattern case-insensitively', () => {
    expect(pickLatestFile(files, { accept: '.xlsx', filePattern: 'REPORT-2026-01*' })?.name).toBe(
      'report-2026-01.xlsx',
    )
  })

  it('returns null when nothing matches', () => {
    expect(pickLatestFile(files, { accept: '.pdf' })).toBeNull()
    expect(pickLatestFile([], {})).toBeNull()
  })

  it('breaks timestamp ties deterministically by filename', () => {
    const tied = [candidate('b.xlsx', 5_000), candidate('a.xlsx', 5_000)]
    expect(pickLatestFile(tied)?.name).toBe('a.xlsx')
  })

  it('treats non-finite timestamps as oldest', () => {
    const invalid = { ...candidate('bad.xlsx', Number.NaN) }
    expect(pickLatestFile([invalid, candidate('good.xlsx', 1)])?.name).toBe('good.xlsx')
  })
})
