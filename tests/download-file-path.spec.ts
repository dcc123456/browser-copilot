/**
 * `file-path` source rules: a workflow may only name a path INSIDE the
 * authorised download folders, and matching never falls back to host paths.
 */
import { describe, expect, it } from 'vitest'
import {
  findDownloadedFileByPath,
  normalizeDownloadFilePath,
} from '../src/lib/workflow/download-file-path'

describe('normalizeDownloadFilePath', () => {
  it('keeps a nested relative path and trims the value', () => {
    expect(normalizeDownloadFilePath('  reports/2026-10/sales.xlsx  ')).toBe(
      'reports/2026-10/sales.xlsx',
    )
  })

  it('converts Windows separators to the stored portable form', () => {
    expect(normalizeDownloadFilePath('reports\\2026-10\\sales.xlsx')).toBe(
      'reports/2026-10/sales.xlsx',
    )
  })

  it('accepts a plain file name and a name with spaces', () => {
    expect(normalizeDownloadFilePath('sales.xlsx')).toBe('sales.xlsx')
    expect(normalizeDownloadFilePath('reports/q3 sales.xlsx')).toBe('reports/q3 sales.xlsx')
  })

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['/etc/passwd', 'absolute POSIX'],
    ['\\\\server\\share\\sales.xlsx', 'UNC'],
    ['C:\\Users\\me\\sales.xlsx', 'drive letter'],
    ['c:sales.xlsx', 'drive-relative'],
    ['reports/../../secret.xlsx', 'parent traversal'],
    ['reports/./sales.xlsx', 'current directory'],
    ['reports//sales.xlsx', 'empty segment'],
    ['reports/sales.xlsx/', 'trailing separator'],
    ['reports/sales\u0000.xlsx', 'control character'],
    ['reports/a:b.xlsx', 'Windows-invalid colon'],
  ])('rejects %s (%s)', (raw) => {
    expect(normalizeDownloadFilePath(raw)).toBeNull()
  })
})

describe('findDownloadedFileByPath', () => {
  const first = { relativePath: 'reports/a.csv', lastModified: 1_000 }
  const second = { relativePath: 'reports/b.csv', lastModified: 2_000 }
  const nested = { relativePath: 'archive/reports/a.csv', lastModified: 3_000 }

  it('matches the exact relative path, not just the file name', () => {
    expect(findDownloadedFileByPath([first, second, nested], 'reports/a.csv')).toBe(first)
  })

  it('returns null when the exact path is absent', () => {
    expect(findDownloadedFileByPath([first, second], 'reports/missing.csv')).toBeNull()
  })

  it('returns null for an invalid requested path', () => {
    expect(findDownloadedFileByPath([first], '../reports/a.csv')).toBeNull()
  })

  it('prefers the newest copy when a path was recorded twice', () => {
    const older = { relativePath: 'reports/a.csv', lastModified: 1_000 }
    const newer = { relativePath: 'reports/a.csv', lastModified: 4_000 }
    expect(findDownloadedFileByPath([older, newer], 'reports/a.csv')).toBe(newer)
  })

  it('falls back to a flat saved file only when asked', () => {
    const flat = { relativePath: 'sales.xlsx', lastModified: 1_000 }
    expect(findDownloadedFileByPath([flat], 'reports/sales.xlsx')).toBeNull()
    expect(
      findDownloadedFileByPath([flat], 'reports/sales.xlsx', { flatBasenameFallback: true }),
    ).toBe(flat)
  })

  it('prefers an exact nested match over the flat fallback', () => {
    const flat = { relativePath: 'sales.xlsx', lastModified: 9_000 }
    const exact = { relativePath: 'reports/sales.xlsx', lastModified: 1_000 }
    expect(
      findDownloadedFileByPath([flat, exact], 'reports/sales.xlsx', {
        flatBasenameFallback: true,
      }),
    ).toBe(exact)
  })

  it('ignores candidates whose stored path is not a safe relative path', () => {
    const unsafe = { relativePath: '../sales.xlsx', lastModified: 9_000 }
    expect(findDownloadedFileByPath([unsafe], '../sales.xlsx')).toBeNull()
  })
})
