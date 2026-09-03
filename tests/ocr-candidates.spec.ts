import { describe, expect, it } from 'vitest'
import { evaluateArithmetic, pickOcrCandidate, scoreOcrCandidate } from '../src/lib/ocr-candidates'

describe('scoreOcrCandidate', () => {
  it('ranks a complete arithmetic expression far above shapeless text', () => {
    const expression = scoreOcrCandidate('7 x 1 =', 63)
    const junk = scoreOcrCandidate('Zl xX 8 =', 43)
    expect(expression).toBeGreaterThan(junk)
  })

  it('ranks a partial expression above a bare word', () => {
    const partial = scoreOcrCandidate('8 -=2 =', 71)
    const word = scoreOcrCandidate('a2', 42)
    expect(partial).toBeGreaterThan(word)
  })

  it('penalizes mixed-case letter noise', () => {
    expect(scoreOcrCandidate('Zl xX', 80)).toBeLessThan(scoreOcrCandidate('7 x1', 80))
  })

  it('returns -1 for empty text', () => {
    expect(scoreOcrCandidate('   ', 90)).toBe(-1)
  })
})

describe('pickOcrCandidate', () => {
  it('passes a single candidate through', () => {
    expect(pickOcrCandidate([{ text: '7 + 9 =', confidence: 78 }])).toEqual({
      text: '7 + 9 =',
      confidence: 78,
      agreed: false,
      alternatives: [],
    })
  })

  it('marks agreement when both passes read the same text', () => {
    const picked = pickOcrCandidate([
      { text: '4 x 6 =', confidence: 84 },
      { text: '4  x 6  =', confidence: 80 },
    ])
    expect(picked.agreed).toBe(true)
    expect(picked.alternatives).toEqual([])
  })

  it('prefers the structural reading over a confident misread', () => {
    const picked = pickOcrCandidate([
      { text: 'Zl xX 8 =', confidence: 90 },
      { text: '7 x 1 =', confidence: 63 },
    ])
    expect(picked.text).toBe('7 x 1 =')
    expect(picked.agreed).toBe(false)
    expect(picked.alternatives).toEqual(['Zl xX 8 ='])
  })

  it('falls back to higher confidence when neither parses', () => {
    const picked = pickOcrCandidate([
      { text: 'a2', confidence: 42 },
      { text: 'a4', confidence: 55 },
    ])
    expect(picked.text).toBe('a4')
  })

  it('handles all-empty input', () => {
    expect(pickOcrCandidate([{ text: ' ', confidence: 0 }])).toEqual({
      text: '',
      confidence: 0,
      agreed: false,
      alternatives: [],
    })
  })
})

describe('evaluateArithmetic', () => {
  it.each([
    ['7 + 9 =', 16],
    ['7 x 1 =', 7],
    ['9 -8 =', 1],
    ['8 ÷ 2 =', 4],
    ['4*6', 24],
    ['3.5 + 1 =', 4.5],
  ])('evaluates %s as %d', (input, expected) => {
    expect(evaluateArithmetic(input)).toBe(expected)
  })

  it.each(['Zl xX 8 =', '8 -=2 =', 'a2', 'hello world', '7 +'])('returns null for %s', (input) => {
    expect(evaluateArithmetic(input)).toBeNull()
  })
})
