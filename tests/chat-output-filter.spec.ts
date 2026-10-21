import { describe, expect, it } from 'vitest'

import { createSessionSummaryFilter, stripSessionSummaryBlocks } from '../src/lib/chat-output'

/** Feeds `text` through a fresh filter in fixed-size chunks. */
function streamed(text: string, size: number): string {
  const filter = createSessionSummaryFilter()
  let out = ''
  for (let index = 0; index < text.length; index += size) {
    out += filter.push(text.slice(index, index + size))
  }
  return out + filter.end()
}

const SUMMARY_BLOCK = [
  '<details>',
  '<summary>Summary</summary>',
  '',
  'Conversation summary: the user asked for X and the assistant did Y.',
  '</details>',
].join('\n')

const SKILL_BLOCK = [
  '<details>',
  '<summary>Skill: login</summary>',
  'Click the username field, then the password field.',
  '</details>',
].join('\n')

describe('stripSessionSummaryBlocks', () => {
  it('removes a trailing summary block and keeps the answer', () => {
    const text = `The draft is cleared.\n\n${SUMMARY_BLOCK}`
    expect(stripSessionSummaryBlocks(text)).toBe('The draft is cleared.\n\n')
  })

  it('removes a summary block between two parts of the answer', () => {
    const text = `before\n${SUMMARY_BLOCK}\nafter`
    expect(stripSessionSummaryBlocks(text)).toBe('before\n\nafter')
  })

  it('keeps a non-Summary <details> block intact', () => {
    expect(stripSessionSummaryBlocks(SKILL_BLOCK)).toBe(SKILL_BLOCK)
  })

  it('is case-insensitive and tolerates attributes', () => {
    const text = 'a<DETAILS open><SUMMARY class="x">  Summary </SUMMARY>b</DETAILS>c'
    expect(stripSessionSummaryBlocks(text)).toBe('ac')
  })

  it('drops an unclosed summary block at end of stream', () => {
    expect(stripSessionSummaryBlocks('answer<details><summary>Summary</summary>tail')).toBe(
      'answer',
    )
  })

  it('keeps an unclosed non-Summary block', () => {
    const text = 'answer<details><summary>Other</summary>tail'
    expect(stripSessionSummaryBlocks(text)).toBe(text)
  })

  it('counts nested <details> when finding the matching close', () => {
    const text =
      'a<details><summary>Summary</summary>outer<details><summary>x</summary>inner</details>end</details>b'
    expect(stripSessionSummaryBlocks(text)).toBe('ab')
  })

  it('passes through a partial tag that never becomes a details block', () => {
    const text = 'please use <detailed instructions> here'
    expect(stripSessionSummaryBlocks(text)).toBe(text)
  })

  it('produces the same result for every chunk size', () => {
    const samples = [
      `answer\n${SUMMARY_BLOCK}\ntail`,
      SKILL_BLOCK,
      'a<details><summary>Summary</summary>nested<details>x</details>z</details>b',
      'lone < at the end',
      '<DETAILS><SUMMARY>Summary</SUMMARY>gone</DETAILS>',
    ]
    for (const sample of samples) {
      const whole = stripSessionSummaryBlocks(sample)
      for (let size = 1; size <= 40; size += 1) {
        expect(streamed(sample, size), `chunk size ${size}`).toBe(whole)
      }
    }
  })

  it('holds back and later releases a tag split across deltas', () => {
    const filter = createSessionSummaryFilter()
    expect(filter.push('hello <det')).toBe('hello ')
    expect(filter.push('ailed note')).toBe('<detailed note')
    expect(filter.end()).toBe('')
  })
})
