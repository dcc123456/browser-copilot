import { describe, expect, it } from 'vitest'
import {
  estimateInputTokens,
  estimateMessageTokens,
  estimateTextTokens,
  hardCapHistory,
} from '../src/lib/context-compact'
import type { WireMessage, WireToolCall } from '../src/lib/llm'
describe('estimateTextTokens (proactive auto-compress)', () => {
  it('counts CJK code points at ~1 token each', () => {
    expect(estimateTextTokens('你好世界')).toBe(4)
  })
  it('counts ASCII at the conservative ~0.35 token/char', () => {
    const tokens = estimateTextTokens('a'.repeat(100))
    expect(tokens).toBe(36)
  })
  it('ignores plain whitespace', () => {
    expect(estimateTextTokens('     ')).toBe(0)
  })
})
describe('estimateInputTokens', () => {
  it('adds message contents, tool calls and extra schema text', () => {
    const messages: WireMessage[] = [
      { role: 'user', content: '提交订单' },
      { role: 'assistant', content: 'ok' },
    ]
    const call: WireToolCall = { id: 'c1', type: 'function', function: { name: 'click', arguments: '{"x":1}' } }
    const withCall: WireMessage = { role: 'assistant', content: null, tool_calls: [call] } as WireMessage
    expect(estimateMessageTokens(withCall)).toBeGreaterThan(estimateTextTokens('click'))
    const total = estimateInputTokens(messages, { text: '{"tools":1}', messages: [withCall] })
    expect(total).toBeGreaterThan(estimateTextTokens('提交订单'))
  })
})
describe('hardCapHistory emergency bound', () => {
  it('leaves fitting history untouched', () => {
    const history: WireMessage[] = [{ role: 'user', content: 'hi' }]
    expect(hardCapHistory(history, 10_000)).toBe(0)
  })
  it('truncates oversized non-user content to fit the budget without deleting messages', () => {
    const history: WireMessage[] = [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'a'.repeat(20_000) },
    ]
    const originalLength = history.length
    const removed = hardCapHistory(history, 2_000)
    expect(removed).toBeGreaterThan(0)
    expect(history.length).toBe(originalLength) // no message dropped
    expect(estimateInputTokens(history)).toBeLessThanOrEqual(2_000)
    expect(String((history[1] as { content: string }).content).endsWith('[truncated]')).toBe(true)
  })
  it('touches user content only as the final pass', () => {
    const history: WireMessage[] = [{ role: 'user', content: '字'.repeat(5_000) }]
    hardCapHistory(history, 1_000)
    expect(estimateInputTokens(history)).toBeLessThanOrEqual(1_000)
  })
})