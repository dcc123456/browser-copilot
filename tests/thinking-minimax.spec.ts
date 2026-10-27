/**
 * MiniMax's thinking control, as the vendor actually answers it.
 *
 * The bodies here were checked against the live API (2026-10-27,
 * `api.minimaxi.com`, model `MiniMax-M3.1-Flash` / `MiniMax-M3`):
 * `reasoning_effort` is accepted on M3.1, `reasoning_effort: 'none'` and
 * `thinking.type: 'disabled'` are answered with a 400 ("requires adaptive
 * thinking"), and on M3 only `thinking.type: 'disabled'` actually stops the
 * thinking. The mapping must therefore offer "off" on M3 and never on M3.1.
 */
import { describe, expect, it } from 'vitest'

import {
  thinkingBodyFor,
  thinkingLevelsFor,
  thinkingModelSupport,
  thinkingVendorOf,
} from '../src/lib/thinking'

const MAINLAND = 'https://api.minimaxi.com/v1'
const INTERNATIONAL = 'https://api.minimax.io/v1'
const CN = 'https://api.minimax.cn/v1'
const CHAT = 'https://api.minimax.chat/v1'

describe('the MiniMax vendor', () => {
  it('is recognized on every endpoint the preset offers', () => {
    for (const url of [MAINLAND, INTERNATIONAL, CN, CHAT]) {
      expect(thinkingVendorOf(url)).toBe('minimax')
    }
  })
})

describe('MiniMax-M3.1-Flash', () => {
  it('offers the three depths and no "off"', () => {
    expect(thinkingLevelsFor(MAINLAND, 'MiniMax-M3.1-Flash')).toEqual(['low', 'medium', 'high'])
    expect(thinkingModelSupport(MAINLAND, 'MiniMax-M3.1-Flash')).toBe('supported')
  })

  it('sends the documented reasoning_effort values', () => {
    expect(thinkingBodyFor(MAINLAND, 'MiniMax-M3.1-Flash', 'low')).toEqual({
      reasoning_effort: 'low',
    })
    expect(thinkingBodyFor(MAINLAND, 'MiniMax-M3.1-Flash', 'medium')).toEqual({
      reasoning_effort: 'medium',
    })
    // "max" is the vendor default, so the strongest level that changes
    // anything is the one above it.
    expect(thinkingBodyFor(MAINLAND, 'MiniMax-M3.1-Flash', 'high')).toEqual({
      reasoning_effort: 'xhigh',
    })
  })

  it('sends nothing for "off", which the model answers with a 400', () => {
    expect(thinkingBodyFor(MAINLAND, 'MiniMax-M3.1-Flash', 'off')).toBeUndefined()
  })

  it('behaves the same on the international endpoint', () => {
    expect(thinkingLevelsFor(INTERNATIONAL, 'MiniMax-M3.1-Flash')).toEqual([
      'low',
      'medium',
      'high',
    ])
    expect(thinkingBodyFor(INTERNATIONAL, 'MiniMax-M3.1-Flash', 'off')).toBeUndefined()
    expect(thinkingBodyFor(INTERNATIONAL, 'MiniMax-M3.1-Flash', 'high')).toEqual({
      reasoning_effort: 'xhigh',
    })
  })
})

describe('MiniMax-M3', () => {
  it('offers only "off", and it turns the thinking off', () => {
    expect(thinkingLevelsFor(MAINLAND, 'MiniMax-M3')).toEqual(['off'])
    expect(thinkingBodyFor(MAINLAND, 'MiniMax-M3', 'off')).toEqual({
      thinking: { type: 'disabled' },
    })
  })

  it('takes no depth level', () => {
    expect(thinkingBodyFor(MAINLAND, 'MiniMax-M3', 'high')).toBeUndefined()
    expect(thinkingBodyFor(MAINLAND, 'MiniMax-M3', 'low')).toBeUndefined()
  })
})

describe('the MiniMax M2 series', () => {
  it('is marked unsupported, because it always thinks', () => {
    for (const model of ['MiniMax-M2.5', 'MiniMax-M2.7', 'minimax-m2.5']) {
      expect(thinkingModelSupport(MAINLAND, model)).toBe('unsupported')
      expect(thinkingLevelsFor(MAINLAND, model)).toEqual([])
      expect(thinkingBodyFor(MAINLAND, model, 'high')).toBeUndefined()
      expect(thinkingBodyFor(MAINLAND, model, 'off')).toBeUndefined()
    }
  })
})
