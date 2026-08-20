import { describe, expect, it } from 'vitest'
import { collapseWhitespace, truncate } from '../src/lib/extract'

describe('collapseWhitespace', () => {
  it('collapses spaces and tabs but keeps paragraph breaks', () => {
    expect(collapseWhitespace('a   \t b')).toBe('a b')
    expect(collapseWhitespace('para one\n\npara two')).toBe('para one\n\npara two')
  })

  it('caps runs of blank lines at one blank line', () => {
    expect(collapseWhitespace('a\n\n\n\n\nb')).toBe('a\n\nb')
  })

  it('normalises CRLF and trims the edges', () => {
    expect(collapseWhitespace('  \r\n line \r\n  ')).toBe('line')
  })

  it('returns an empty string for whitespace-only input', () => {
    expect(collapseWhitespace('   \n\t  ')).toBe('')
  })
})

describe('truncate', () => {
  it('leaves text within budget untouched', () => {
    expect(truncate('short', 100)).toEqual({ text: 'short', truncated: false })
  })

  it('breaks on a word boundary when one is close to the limit', () => {
    const input = 'aaaa bbbb cccc dddd eeee'
    const result = truncate(input, 20)
    expect(result.truncated).toBe(true)
    // Must not end mid-word.
    expect(input.startsWith(result.text)).toBe(true)
    expect(result.text.endsWith('dddd')).toBe(true)
  })

  it('hard-cuts when honouring the boundary would waste the budget', () => {
    // One long unbroken token: no boundary is within 80% of the limit.
    const result = truncate('x'.repeat(100), 10)
    expect(result).toEqual({ text: 'x'.repeat(10), truncated: true })
  })

  it('handles a zero or negative budget without throwing', () => {
    expect(truncate('anything', 0)).toEqual({ text: '', truncated: true })
    expect(truncate('', 0)).toEqual({ text: '', truncated: false })
  })

  it('never returns more than the budget', () => {
    const result = truncate('word '.repeat(500), 120)
    expect(result.text.length).toBeLessThanOrEqual(120)
  })
})
