import { describe, expect, it } from 'vitest'
import { trimConversation } from '../src/lib/storage'
import type { WireMessage } from '../src/lib/llm'

const user = (text: string): WireMessage => ({ role: 'user', content: text })
const assistant = (text: string): WireMessage => ({ role: 'assistant', content: text })
const toolCall = (id: string): WireMessage => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name: 'read_current_page', arguments: '{}' } }],
})
const toolResult = (id: string): WireMessage => ({
  role: 'tool',
  tool_call_id: id,
  content: '{}',
})

describe('trimConversation', () => {
  it('leaves a short transcript untouched', () => {
    const messages = [user('a'), assistant('b')]
    expect(trimConversation(messages, 10)).toEqual(messages)
  })

  it('returns the same array identity when no trim is needed', () => {
    const messages = [user('a')]
    expect(trimConversation(messages, 10)).toBe(messages)
  })

  it('keeps the newest turns when over the limit', () => {
    const messages = [user('1'), assistant('2'), user('3'), assistant('4')]
    expect(trimConversation(messages, 2)).toEqual([user('3'), assistant('4')])
  })

  it('never starts the window on an orphaned tool result', () => {
    // Cutting to the last 2 would strand the tool result without its tool_calls
    // turn, which providers reject with a 400.
    const messages = [user('q'), toolCall('c1'), toolResult('c1'), assistant('done')]
    const trimmed = trimConversation(messages, 2)
    expect(trimmed[0]!.role).not.toBe('tool')
    expect(trimmed).toEqual([assistant('done')])
  })

  it('skips a run of consecutive tool results at the boundary', () => {
    const messages = [
      user('q'),
      toolCall('c1'),
      toolResult('c1'),
      toolResult('c2'),
      toolResult('c3'),
      assistant('done'),
    ]
    const trimmed = trimConversation(messages, 4)
    expect(trimmed.every((message, index) => index > 0 || message.role !== 'tool')).toBe(true)
    expect(trimmed).toEqual([assistant('done')])
  })

  it('handles a transcript that is entirely tool results', () => {
    const messages = [toolResult('a'), toolResult('b')]
    expect(trimConversation(messages, 1)).toEqual([])
  })

  it('handles an empty transcript', () => {
    expect(trimConversation([], 5)).toEqual([])
  })
})
