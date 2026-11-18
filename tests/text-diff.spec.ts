import { describe, expect, it } from 'vitest'
import { diffTextLines } from '../src/lib/text-diff'

describe('diffTextLines', () => {
  it('returns context rows with both line numbers for unchanged text', () => {
    expect(diffTextLines('const a = 1\nreturn a', 'const a = 1\nreturn a')).toEqual([
      { kind: 'context', text: 'const a = 1', oldNumber: 1, newNumber: 1 },
      { kind: 'context', text: 'return a', oldNumber: 2, newNumber: 2 },
    ])
  })

  it('marks an inserted line as added and keeps the surrounding context', () => {
    const rows = diffTextLines('first\nthird', 'first\nsecond\nthird')
    expect(rows).toEqual([
      { kind: 'context', text: 'first', oldNumber: 1, newNumber: 1 },
      { kind: 'added', text: 'second', newNumber: 2 },
      { kind: 'context', text: 'third', oldNumber: 2, newNumber: 3 },
    ])
  })

  it('shows a replaced line as a removal followed by an addition', () => {
    const rows = diffTextLines('url = "https://a"', 'url = "https://b"')
    expect(rows).toEqual([
      { kind: 'removed', text: 'url = "https://a"', oldNumber: 1 },
      { kind: 'added', text: 'url = "https://b"', newNumber: 1 },
    ])
  })

  it('handles an empty side and CRLF or trailing newlines', () => {
    expect(diffTextLines('', 'new line\n')).toEqual([
      { kind: 'added', text: 'new line', newNumber: 1 },
    ])
    expect(diffTextLines('old line\r\n', '')).toEqual([
      { kind: 'removed', text: 'old line', oldNumber: 1 },
    ])
    expect(diffTextLines('', '')).toEqual([])
  })

  it('keeps repeated lines distinct by their positions', () => {
    const rows = diffTextLines('x\nx\nx', 'x\nx')
    expect(rows).toEqual([
      { kind: 'context', text: 'x', oldNumber: 1, newNumber: 1 },
      { kind: 'context', text: 'x', oldNumber: 2, newNumber: 2 },
      { kind: 'removed', text: 'x', oldNumber: 3 },
    ])
  })

  it('falls back to a full replace when the LCS table would be too large', () => {
    const oldText = Array.from({ length: 1001 }, (_, index) => `old ${index}`).join('\n')
    const newText = Array.from({ length: 1001 }, (_, index) => `new ${index}`).join('\n')
    const rows = diffTextLines(oldText, newText)
    expect(rows).toHaveLength(2002)
    expect(rows[0]).toEqual({ kind: 'removed', text: 'old 0', oldNumber: 1 })
    expect(rows[1000]).toEqual({ kind: 'removed', text: 'old 1000', oldNumber: 1001 })
    expect(rows[1001]).toEqual({ kind: 'added', text: 'new 0', newNumber: 1 })
  })
})
