import { describe, expect, it } from 'vitest'
import { buildAnswerFilename, hasTables, toCsv } from '../src/lib/export-answer'

describe('toCsv', () => {
  it('renders a simple table to header + data rows', () => {
    const md = [
      '| Name | Age |',
      '| --- | --- |',
      '| Alice | 30 |',
      '| Bob | 25 |',
    ].join('\n')
    expect(toCsv(md)).toBe('Name,Age\nAlice,30\nBob,25')
  })

  it('escapes cells containing a comma, a double-quote, or a newline', () => {
    // Commas and quotes flow straight through from the Markdown cells; the
    // RFC-4180 wrapper quotes them and doubles internal double-quotes.
    const md = [
      '| A | B |',
      '| --- | --- |',
      '| "quoted" | a, b |',
    ].join('\n')
    expect(toCsv(md)).toBe('A,B\n"""quoted""","a, b"')
    // The newline branch shares this same quote-wrapping code path ("if the
    // value contains ", , or \n, wrap and double quotes"). A raw newline in a
    // markdown cell is not reachable through the table parser, which splits
    // rows on physical lines, so there is no markdown input that yields a
    // newline-bearing cell to exercise here.
  })

  it('separates consecutive tables with a blank line', () => {
    const md = [
      '| X | Y |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '| P | Q |',
      '| --- | --- |',
      '| 3 | 4 |',
    ].join('\n')
    expect(toCsv(md)).toBe('X,Y\n1,2\n\nP,Q\n3,4')
  })
})

describe('hasTables', () => {
  it('returns true when the Markdown contains a table', () => {
    expect(hasTables('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(true)
  })

  it('returns false when the Markdown has no table', () => {
    expect(hasTables('just some **plain** text')).toBe(false)
    expect(hasTables('')).toBe(false)
  })
})

describe('buildAnswerFilename', () => {
  it("yields a '.csv' extension for the csv format", () => {
    expect(buildAnswerFilename('csv', 'Some title', 'fallback', 0)).toMatch(/\.csv$/)
    expect(buildAnswerFilename('csv', 'Some title', 'fallback', 0)).toBe(
      'Some title-1970-01-01T00-00-00.csv',
    )
  })
})