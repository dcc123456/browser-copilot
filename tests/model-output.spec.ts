/**
 * Tests for `lib/model-output` — the normalizers applied to model replies
 * that get stored into workflow variables (the workflow AI operators):
 *   - stripThinkBlocks: `<think>` family pairs, a lone closing tag (stream cut
 *     mid-thought), an unterminated opening tag;
 *   - unwrapFencedAnswer: a reply that is exactly one ``` fence;
 *   - sanitizeModelAnswer: the one-pass combination (idempotent).
 */
import { describe, expect, it } from 'vitest'
import {
  sanitizeModelAnswer,
  splitThinkSegments,
  stripThinkBlocks,
  unwrapFencedAnswer,
} from '../src/lib/model-output'

describe('stripThinkBlocks', () => {
  it('removes paired think blocks and keeps the answer', () => {
    expect(stripThinkBlocks('<think>weigh options</think>the answer')).toBe('the answer')
    expect(stripThinkBlocks('a<think>weigh {"id":"x"} options</think>b')).toBe('ab')
  })

  it('is case-insensitive and handles repeated blocks', () => {
    expect(stripThinkBlocks('<THINK>x</THINK>ok<Think>y</Think>')).toBe('ok')
  })

  it('drops everything before a lone closing tag (stream cut mid-thought)', () => {
    expect(stripThinkBlocks('partial reasoning with {"keep":false}…</think>{"ok":1}')).toBe(
      '{"ok":1}',
    )
  })

  it('drops the tail after an unterminated opening tag', () => {
    expect(stripThinkBlocks('<think>ran out of tokens mid')).toBe('')
    expect(stripThinkBlocks('keep me <think>hidden tail')).toBe('keep me ')
  })

  it('handles the thinking/thought/reasoning tag variants', () => {
    expect(stripThinkBlocks('<thinking>a</thinking>b')).toBe('b')
    expect(stripThinkBlocks('<thought>a</thought>b')).toBe('b')
    expect(stripThinkBlocks('<reasoning>a</reasoning>b')).toBe('b')
  })

  it('leaves plain text untouched', () => {
    expect(stripThinkBlocks('{"summary":"s"}')).toBe('{"summary":"s"}')
    expect(stripThinkBlocks('')).toBe('')
  })
})

describe('splitThinkSegments', () => {
  it('returns one answer segment for plain text', () => {
    expect(splitThinkSegments('just an answer')).toEqual([
      { kind: 'answer', text: 'just an answer', closed: true },
    ])
    expect(splitThinkSegments('')).toEqual([])
  })

  it('splits a completed think block from the answer in order', () => {
    expect(splitThinkSegments('<think>reasoning</think>the answer')).toEqual([
      { kind: 'think', text: 'reasoning', closed: true },
      { kind: 'answer', text: 'the answer', closed: true },
    ])
  })

  it('keeps text before and after a think block as separate answer runs', () => {
    expect(splitThinkSegments('a<think>hmm</think>b')).toEqual([
      { kind: 'answer', text: 'a', closed: true },
      { kind: 'think', text: 'hmm', closed: true },
      { kind: 'answer', text: 'b', closed: true },
    ])
  })

  it('marks an unterminated think block as streaming (closed=false)', () => {
    expect(splitThinkSegments('<think>still reasoning')).toEqual([
      { kind: 'think', text: 'still reasoning', closed: false },
    ])
    expect(splitThinkSegments('answer first <think>now thinking')).toEqual([
      { kind: 'answer', text: 'answer first ', closed: true },
      { kind: 'think', text: 'now thinking', closed: false },
    ])
  })

  it('holds back a tag cut in half at the end of a streamed answer', () => {
    expect(splitThinkSegments('answer <thi')).toEqual([
      { kind: 'answer', text: 'answer ', closed: true },
    ])
    expect(splitThinkSegments('<think>x</think>answer</thin')).toEqual([
      { kind: 'think', text: 'x', closed: true },
      { kind: 'answer', text: 'answer', closed: true },
    ])
  })

  it('keeps stray tag-shaped text inside a think block verbatim', () => {
    expect(splitThinkSegments('<think>a < b and </b></think>done')).toEqual([
      { kind: 'think', text: 'a < b and </b>', closed: true },
      { kind: 'answer', text: 'done', closed: true },
    ])
  })

  it('classifies text before a lone closing tag as reasoning', () => {
    expect(splitThinkSegments('reasoning without open</think>answer')).toEqual([
      { kind: 'think', text: 'reasoning without open', closed: true },
      { kind: 'answer', text: 'answer', closed: true },
    ])
  })

  it('handles repeated blocks, variants and casing', () => {
    expect(splitThinkSegments('<THINK>x</THINK>ok<think>y</think>z')).toEqual([
      { kind: 'think', text: 'x', closed: true },
      { kind: 'answer', text: 'ok', closed: true },
      { kind: 'think', text: 'y', closed: true },
      { kind: 'answer', text: 'z', closed: true },
    ])
    expect(splitThinkSegments('<reasoning>r</reasoning>a')).toEqual([
      { kind: 'think', text: 'r', closed: true },
      { kind: 'answer', text: 'a', closed: true },
    ])
  })

  it('does not hold back an unrelated tag-like tail', () => {
    expect(splitThinkSegments('see <table> below')).toEqual([
      { kind: 'answer', text: 'see <table> below', closed: true },
    ])
  })
})

describe('unwrapFencedAnswer', () => {
  it('unwraps a single fenced block, with or without a language tag', () => {
    expect(unwrapFencedAnswer('```\nplain inside\n```')).toBe('plain inside')
    expect(unwrapFencedAnswer('```json\n{"a": 1}\n```')).toBe('{"a": 1}')
  })

  it('tolerates CRLF and surrounding whitespace', () => {
    expect(unwrapFencedAnswer('  ```text\r\nhello\r\n```\n')).toBe('hello')
  })

  it('keeps fenced content that itself contains a fence', () => {
    const inner = 'outer\n```js\ncode()\n```\ntail'
    const wrapped = '```\n' + inner + '\n```'
    expect(unwrapFencedAnswer(wrapped)).toBe(inner)
  })

  it('does NOT unwrap when prose surrounds the fence', () => {
    const reply = 'Here is the JSON:\n```json\n{"a": 1}\n```'
    expect(unwrapFencedAnswer(reply)).toBe(reply)
  })

  it('passes through non-fenced text unchanged', () => {
    expect(unwrapFencedAnswer('just an answer')).toBe('just an answer')
    expect(unwrapFencedAnswer('')).toBe('')
  })
})

describe('sanitizeModelAnswer', () => {
  it('strips thinking, then unwraps a fenced answer, then trims', () => {
    expect(sanitizeModelAnswer('<think>let me see…</think>\n```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(sanitizeModelAnswer('  <think>x</think> final  ')).toBe('final')
  })

  it('collapses a thinking-only reply to an empty string', () => {
    expect(sanitizeModelAnswer('<think>only reasoning, no answer')).toBe('')
  })

  it('is idempotent on clean input', () => {
    const once = sanitizeModelAnswer('<think>t</think>\n```json\n{"a":1}\n```')
    expect(sanitizeModelAnswer(once)).toBe(once)
    expect(sanitizeModelAnswer('clean answer')).toBe('clean answer')
  })

  it('keeps multi-line data bodies intact', () => {
    const body = 'line one\nline two'
    const wrapped = '```\n' + body + '\n```'
    expect(sanitizeModelAnswer(wrapped)).toBe(body)
  })
})
